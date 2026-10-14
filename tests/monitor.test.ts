import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getState, setState } from "../src/state.js";
import { startHealthMonitor, recoverBackoffMs, type MonitorDeps } from "../src/monitor/token.js";
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

  it("recoverBackoffMs：5/10/20 分鐘後 30 分鐘封頂", () => {
    assert.equal(recoverBackoffMs(3), 5 * 60 * 1000);
    assert.equal(recoverBackoffMs(4), 10 * 60 * 1000);
    assert.equal(recoverBackoffMs(5), 20 * 60 * 1000);
    assert.equal(recoverBackoffMs(6), 30 * 60 * 1000);
    assert.equal(recoverBackoffMs(99), 30 * 60 * 1000);
  });

  it("連續重登失敗達 3 次後退避：間隔指數拉長，成功即重置", async () => {
    let healthy = false;
    const recoverOk = false;
    const recoveries = { count: 0 };
    const svc = {
      platform: "telegram",
      healthCheck: async () => healthy,
      recover: async () => {
        recoveries.count++;
        return recoverOk;
      },
    } as unknown as IMessagingService;
    const h = harness([svc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick(); // 失敗 1
      await monitor.tick(); // 失敗 2
      await monitor.tick(); // 失敗 3 → 之後退避 5 分鐘
      assert.equal(recoveries.count, 3);
      await monitor.tick(); // 同一時刻 → 退避中，跳過
      assert.equal(recoveries.count, 3);
      h.clock.now += 6 * 60 * 1000;
      await monitor.tick(); // 過 5 分鐘退避 → 第 4 次（仍失敗，退避拉到 10 分鐘）
      assert.equal(recoveries.count, 4);
      await monitor.tick(); // 同一時刻 → 退避中（10 分鐘），跳過
      assert.equal(recoveries.count, 4);
      h.clock.now += 11 * 60 * 1000;
      await monitor.tick(); // 過 10 分鐘 → 第 5 次
      assert.equal(recoveries.count, 5);

      // 成功一次即重置：下次失敗從第 1 次重算，不退避
      healthy = true;
      await monitor.tick();
      healthy = false;
      await monitor.tick();
      assert.equal(recoveries.count, 6, "重置後立即重試，不退避");
    } finally {
      monitor.stop();
    }
  });

  it("recover 拋例外也計入連敗（不產生未處理 rejection）", async () => {
    const recoveries = { count: 0 };
    const svc = {
      platform: "telegram",
      healthCheck: async () => false,
      recover: async () => {
        recoveries.count++;
        throw new Error("boom");
      },
    } as unknown as IMessagingService;
    const h = harness([svc]);
    const monitor = startHealthMonitor(h.deps);
    try {
      await monitor.tick();
      await monitor.tick();
      await monitor.tick();
      assert.equal(recoveries.count, 3);
      await monitor.tick(); // 退避中，跳過
      assert.equal(recoveries.count, 3);
    } finally {
      monitor.stop();
    }
  });
});
