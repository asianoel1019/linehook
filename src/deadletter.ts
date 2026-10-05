import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";

export interface DeadLetter {
  time: string;
  platform: string;
  kind: string;
  to: string[];
  summary: string;
  error: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const LIMIT = 500;

/** 寫入死信：永久性失敗的發送（佇列／排程／技能回覆），不再靜默消失。 */
export function writeDeadLetter(entry: Omit<DeadLetter, "time">): void {
  try {
    mkdirSync(dirname(config.deadletterPath), { recursive: true });
    const record: DeadLetter = { time: new Date().toISOString(), ...entry };
    appendFileSync(config.deadletterPath, `${JSON.stringify(record)}\n`);
    rotateIfNeeded(config.deadletterPath, MAX_BYTES, MAX_FILES);
    logger.warn("已寫入死信", { platform: record.platform, kind: record.kind, to: record.to });
  } catch (error) {
    logger.warn("寫入死信失敗", { error: String(error) });
  }
}

/** 讀取最近死信（供 /console 檢視與重送判斷）。 */
export function readDeadLetters(limit = 100): DeadLetter[] {
  try {
    if (!existsSync(config.deadletterPath)) return [];
    const lines = readFileSync(config.deadletterPath, "utf8").split("\n").filter(Boolean);
    const out: DeadLetter[] = [];
    for (const line of lines.slice(-LIMIT)) {
      try {
        out.push(JSON.parse(line) as DeadLetter);
      } catch {
        // skip malformed
      }
    }
    return out.slice(-Math.max(1, Math.min(limit, LIMIT)));
  } catch {
    return [];
  }
}
