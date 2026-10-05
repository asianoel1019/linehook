import { getStore } from "./store/index.js";
import { logger } from "./logger.js";

export interface DeadLetter {
  time: string;
  platform: string;
  kind: string;
  to: string[];
  summary: string;
  error: string;
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
