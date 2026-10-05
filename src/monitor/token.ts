import { config } from "../config.js";
import { logger } from "../logger.js";
import { getState, setState } from "../state.js";
import { sendMail } from "../notify/mailer.js";
import { listServices } from "../messaging/services.js";

export interface HealthMonitor {
  stop(): void;
}

const PENDING_STATUSES = new Set(["未登入", "登入中", "待驗證"]);

/** 告警去抖：首次 + N 分鐘後重發 + 恢復通知（C2）。 */
const RESEND_MINUTES = 30;

interface PlatformHealth {
  healthy: boolean;
  notified: boolean;
  recovering: boolean;
  lastAlertAt: number;
}

export function startHealthMonitor(): HealthMonitor {
  const states = new Map<string, PlatformHealth>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stateFor = (platform: string): PlatformHealth => {
    let s = states.get(platform);
    if (!s) {
      s = { healthy: true, notified: false, recovering: false, lastAlertAt: 0 };
      states.set(platform, s);
    }
    return s;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), config.healthCheckIntervalSec * 1000);
    timer.unref?.();
  };

  const alert = (platform: string, st: PlatformHealth, subject: string, lines: string[]): void => {
    st.notified = true;
    st.lastAlertAt = Date.now();
    void sendMail(subject, lines.join("\n"));
  };

  const run = async (): Promise<void> => {
    try {
      for (const svc of listServices()) {
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
            alert(
              svc.platform,
              st,
              `[IM Webhook] ${svc.platform} 已恢復`,
              [`${svc.platform} 連線已恢復。`, "", `時間：${new Date().toISOString()}`],
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

        // C2：連「需人工」也納入告警；去抖：首次 + 30 分鐘重發。
        const due = !st.notified || Date.now() - st.lastAlertAt > RESEND_MINUTES * 60 * 1000;
        if (st.healthy || due) {
          st.healthy = false;
          logger.error("偵測到連線失效，嘗試自動重登", { platform: svc.platform });
          if (svc.platform === "line") setState({ status: "已過期", lastError: "登入失效" });
          alert(
            svc.platform,
            st,
            `[IM Webhook] ${svc.platform} 連線失效${needsHuman ? "（需人工處理）" : ""}`,
            [
              `${svc.platform} 連線檢查失敗，系統正嘗試自動重登。`,
              needsHuman ? "狀態為「需人工」，請開啟狀態頁手動處理。" : "若需要人工重新驗證（QR / PIN），請開啟狀態頁查看。",
              "",
              `時間：${new Date().toISOString()}`,
            ],
          );
        }

        st.recovering = true;
        void svc.recover().finally(() => {
          st.recovering = false;
        });
      }
    } finally {
      schedule();
    }
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
