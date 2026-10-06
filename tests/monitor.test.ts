import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getState, setState } from "../src/state.js";
import { startHealthMonitor, type MonitorDeps } from "../src/monitor/token.js";
import type { IMessagingService } from "../src/messaging/types.js";

interface Harness {
  deps: MonitorDeps;
  alerts: Array<{ subject: string; text: string }>;
  pings: number;
  clock: { now: number };
  deadletters: { count: number };
}

function harness(services: IMessagingService[]): Harness {
  const alerts: Array<{ subject: string; text: string }> = [];
  const clock = { now: 1_000_000 };
  const deadletters = { count: 0 };
  const h: Harness = {
    alerts,
    clock,
    deadletters,
    pings: 0,
    deps: {
      services: () => services,
      alert: (subject, text) => {
        alerts.push({ subject, text });
      },
      ping: () => {
        h.pings++;
      },
      deadletterCount: () => deadletters.count,
      now: () => clock.now,
    },
  };
  return h;
}

function fakeService(platform: IMessagingService["platform"], health: () => boolean): {
  svc: IMessagingService;
  recoveries: { count: number };
} {
  const recoveries = { count: 0 };
  const svc = {
    platform,
    healthCheck: async () => health(),
    recover: async () => {
      recoveries.count++;
      return true;
    },
  } as unknown as IMessagingService;
  return { svc, recoveries };
}

describe("startHealthMonitor", () => {
  const originalAlert = { ...config.alert };
  const originalStatus = getState().status;

  beforeEach(() => {
    config.alert = { webhookUrls: [], deadmanUrl: "", deadletterThreshold: 0, resendMinutes: 30 };
  });

  afterEach(() => {
    config.alert = { ...originalAlert };
    setState({ status: originalStatus });
  });

  it("失效當下告警、去抖期間不重發、超過間隔才重發、恢復再通知", async () => {
    let healthy = true;
    const { svc } = fakeService("telegram", () => healthy);
    const h = harness([svc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      assert.equal(h.alerts.length, 0, "健康時不告警");

      healthy = false;
      await monitor.tick();
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0].subject, /telegram 連線失效/);

      await monitor.tick();
      assert.equal(h.alerts.length, 1, "去抖期間不重發");

      h.clock.now += 31 * 60 * 1000;
      await monitor.tick();
      assert.equal(h.alerts.length, 2, "超過重發間隔要再發一次");

      healthy = true;
      await monitor.tick();
      assert.equal(h.alerts.length, 3);
      assert.match(h.alerts[2].subject, /已恢復/);

      h.clock.now += 31 * 60 * 1000;
      await monitor.tick();
      assert.equal(h.alerts.length, 3, "恢復後穩定則不再告警");
    } finally {
      monitor.stop();
    }
  });

  it("重發間隔取自 config.alert.resendMinutes", async () => {
    config.alert.resendMinutes = 5;
    const healthy = false;
    const { svc } = fakeService("telegram", () => healthy);
    const h = harness([svc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      h.clock.now += 6 * 60 * 1000;
      await monitor.tick();
      assert.equal(h.alerts.length, 2, "5 分鐘設定下 6 分鐘後可重發");
    } finally {
      monitor.stop();
    }
  });

  it("healthCheck 拋例外視為失效但不會中斷整輪", async () => {
    const boom = {
      platform: "whatsapp",
      healthCheck: async () => {
        throw new Error("boom");
      },
      recover: async () => true,
    } as unknown as IMessagingService;
    const okSvc = fakeService("telegram", () => true).svc;
    const h = harness([boom, okSvc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0].subject, /whatsapp 連線失效/);
    } finally {
      monitor.stop();
    }
  });

  it("LINE 於「未登入／登入中」待定狀態不告警（避免啟動期誤報）", async () => {
    const { svc } = fakeService("line", () => false);
    const h = harness([svc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      setState({ status: "未登入" });
      await monitor.tick();
      assert.equal(h.alerts.length, 0, "pending 狀態不告警");
    } finally {
      monitor.stop();
    }
  });

  it("死信超過閾值告警、去抖重發、降回閾值以下再超時重新告警", async () => {
    config.alert.deadletterThreshold = 3;
    const h = harness([]);
    h.deadletters.count = 5;
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0].subject, /死信積壓/);

      await monitor.tick();
      assert.equal(h.alerts.length, 1, "去抖期間不重發");

      h.clock.now += 31 * 60 * 1000;
      await monitor.tick();
      assert.equal(h.alerts.length, 2);

      h.deadletters.count = 1;
      await monitor.tick();
      h.deadletters.count = 5;
      await monitor.tick();
      assert.equal(h.alerts.length, 3, "降回閾值以下後再次超標要重新告警");
    } finally {
      monitor.stop();
    }
  });

  it("閾值為 0 時不因死信告警", async () => {
    config.alert.deadletterThreshold = 0;
    const h = harness([]);
    h.deadletters.count = 999;
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      assert.equal(h.alerts.length, 0);
    } finally {
      monitor.stop();
    }
  });

  it("每輪都會打 dead-man ping（程序掛掉才不會打）", async () => {
    const h = harness([]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      await monitor.tick();
      assert.equal(h.pings, 2);
    } finally {
      monitor.stop();
    }
  });
});
