import { getStore } from "./store/index.js";
import { logger } from "./logger.js";

export interface DeadLetter {
  time: string;
  platform: string;
  kind: string;
  to: string[];
  summary: string;
  error: string;
  /** 重送所需的原始輸入（SendInput[]）；技能類無 payload（無法單獨重跑）。 */
  payload?: unknown;
}

const LIMIT = 500;

/** 寫入死信：永久性失敗的發送（佇列／排程／技能回覆），不再靜默消失。 */
export function writeDeadLetter(entry: Omit<DeadLetter, "time">): void {
  try {
    const record: DeadLetter = { time: new Date().toISOString(), ...entry };
    getStore().append("deadletter", { ...record, to: [...record.to] });
    logger.warn("已寫入死信", { platform: record.platform, kind: record.kind, to: record.to });
  } catch (error) {
    logger.warn("寫入死信失敗", { error: String(error) });
  }
}

/** 讀取最近死信（供 /console 檢視與重送判斷）。 */
export function readDeadLetters(limit = 100): DeadLetter[] {
  try {
    const rows = getStore().query("deadletter", { limit: Math.max(1, Math.min(limit, LIMIT)) });
    return rows as unknown as DeadLetter[];
  } catch {
    return [];
  }
}

/** 死信總筆數（C2 佇列積壓告警用）。 */
export function countDeadLetters(): number {
  try {
    return getStore().count("deadletter").total;
  } catch {
    return 0;
  }
}

/** 清除全部死信（store + 對應流水檔）；回傳清除筆數。 */
export function purgeDeadLetters(): number {
  try {
    const removed = getStore().purge("deadletter");
    if (removed > 0) logger.info("已清除死信", { removed });
    return removed;
  } catch (error) {
    logger.warn("清除死信失敗", { error: String(error) });
    return 0;
  }
}
