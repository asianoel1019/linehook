import { config } from "../config.js";
import { logger } from "../logger.js";
import { getState, setState } from "../state.js";
import { sendAlert, pingDeadman } from "../notify/alert.js";
import { listServices } from "../messaging/services.js";
import { countDeadLetters } from "../deadletter.js";
import type { IMessagingService } from "../messaging/types.js";

export interface HealthMonitor {
  stop(): void;
  /** 手動跑一輪（測試與除錯用；正常情況由計時器自動排程）。 */
  tick(): Promise<void>;
}

/** 可注入的監控依賴（預設走真實服務；測試傳入假服務與假時鐘）。 */
export interface MonitorDeps {
  services: () => IMessagingService[];
  alert: (subject: string, text: string) => void;
  ping: () => void;
  deadletterCount: () => number;
  now: () => number;
}

const PENDING_STATUSES = new Set(["未登入", "登入中", "待驗證"]);

interface DebounceState {
  healthy: boolean;
  notified: boolean;
  recovering: boolean;
  lastAlertAt: number;
}

export function startHealthMonitor(overrides: Partial<MonitorDeps> = {}): HealthMonitor {
  const deps: MonitorDeps = {
    services: () => listServices(),
    alert: (subject, text) => {
      void sendAlert(subject, text);
    },
    ping: () => {
      void pingDeadman();
    },
    deadletterCount: () => countDeadLetters(),
    now: () => Date.now(),
    ...overrides,
  };

  const states = new Map<string, DebounceState>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let deadletterNotified = false;
  let deadletterLastAlertAt = 0;

  const stateFor = (key: string): DebounceState => {
    let s = states.get(key);
    if (!s) {
      s = { healthy: true, notified: false, recovering: false, lastAlertAt: 0 };
      states.set(key, s);
    }
    return s;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), config.healthCheckIntervalSec * 1000);
    timer.unref?.();
  };

  /** 同一事由的重發間隔（C2 去抖：首次 + 每 N 分鐘重發）。 */
  const due = (lastAlertAt: number): boolean => deps.now() - lastAlertAt > config.alert.resendMinutes * 60 * 1000;

  const checkDeadletter = (): void => {
    const threshold = config.alert.deadletterThreshold;
    if (threshold <= 0) return;
    const total = deps.deadletterCount();
    if (total < threshold) {
      deadletterNotified = false;
      return;
    }
    if (deadletterNotified && !due(deadletterLastAlertAt)) return;
    deadletterNotified = true;
    deadletterLastAlertAt = deps.now();
    logger.error("死信積壓超過閾值", { total, threshold });
    deps.alert(
      "[IM Webhook] 死信積壓",
      [
        `目前有 ${total} 筆死信（閾值 ${threshold}），代表有訊息永久性發送失敗。`,
        "請至 /console 的「死信」檢視原因並重送或清除。",
        "",
        `時間：${new Date(deps.now()).toISOString()}`,
      ].join("\n"),
    );
  };

  const checkPlatforms = async (): Promise<void> => {
    for (const svc of deps.services()) {
      const st = stateFor(svc.platform);
      let ok = false;
      try {
        ok = await svc.healthCheck();
      } catch (error) {
        logger.warn("健康檢查例外", { platform: svc.platform, error: String(error) });
      }

      if (ok) {
        if (!st.healthy) {
          logger.info("連線已恢復", { platform: svc.platform });
          if (svc.platform === "line") setState({ status: "已登入", lastError: undefined });
          deps.alert(
            `[IM Webhook] ${svc.platform} 已恢復`,
            [`${svc.platform} 連線已恢復。`, "", `時間：${new Date(deps.now()).toISOString()}`].join("\n"),
          );
        }
        st.healthy = true;
        st.notified = false;
        continue;
      }

      if (st.recovering) continue;
      const needsHuman = svc.platform === "line" && getState().status === "需人工";
      if (!needsHuman && svc.platform === "line" && PENDING_STATUSES.has(getState().status)) {
        continue;
      }

      // 連「需人工」也納入告警；去抖：首次 + 每 N 分鐘重發。
      if (st.healthy || st.notified === false || due(st.lastAlertAt)) {
        st.healthy = false;
        st.notified = true;
        st.lastAlertAt = deps.now();
        logger.error("偵測到連線失效，嘗試自動重登", { platform: svc.platform });
        if (svc.platform === "line") setState({ status: "已過期", lastError: "登入失效" });
        deps.alert(
          `[IM Webhook] ${svc.platform} 連線失效${needsHuman ? "（需人工處理）" : ""}`,
          [
            `${svc.platform} 連線檢查失敗，系統正嘗試自動重登。`,
            needsHuman ? "狀態為「需人工」，請開啟狀態頁手動處理。" : "若需要人工重新驗證（QR / PIN），請開啟狀態頁查看。",
            "",
            `時間：${new Date(deps.now()).toISOString()}`,
          ].join("\n"),
        );
      }

      st.recovering = true;
      void svc.recover().finally(() => {
        st.recovering = false;
      });
    }
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await checkPlatforms();
      checkDeadletter();
      // dead-man's switch：程式掛掉就不會 ping，由外部 uptime 服務在逾時後告警。
      deps.ping();
    } catch (error) {
      logger.error("健康檢查週期例外", { error: String(error) });
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick: run,
  };
}
