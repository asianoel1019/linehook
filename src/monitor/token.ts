import { config } from "../config.js";
import { logger } from "../logger.js";
import { getState, setState } from "../state.js";
import { sendMail } from "../notify/mailer.js";
import type { LineService } from "../line/client.js";

const PENDING_STATUSES = new Set(["未登入", "登入中", "待驗證"]);

export interface HealthMonitor {
  stop(): void;
}

export function startHealthMonitor(line: LineService): HealthMonitor {
  let healthy = true;
  let notified = false;
  let recovering = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), config.healthCheckIntervalSec * 1000);
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    try {
      const ok = await line.healthCheck();

      if (ok) {
        if (!healthy) {
          logger.info("LINE 連線已恢復");
          setState({ status: "已登入", lastError: undefined });
        }
        healthy = true;
        notified = false;
        return;
      }

      if (recovering || PENDING_STATUSES.has(getState().status)) {
        return;
      }

      if (healthy) {
        healthy = false;
        logger.error("偵測到 LINE 登入失效，嘗試自動重登");
        setState({ status: "已過期", lastError: "登入失效" });

        if (!notified) {
          notified = true;
          void sendMail(
            "[LINE Webhook] 登入失效通知",
            [
              "LINE 帳號登入已失效，系統正嘗試自動重登。",
              "若需要人工重新驗證（QR / PIN），請開啟狀態頁查看。",
              "",
              `時間：${new Date().toISOString()}`,
            ].join("\n"),
          );
        }
      }

      recovering = true;
      void line.recover().finally(() => {
        recovering = false;
      });
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
