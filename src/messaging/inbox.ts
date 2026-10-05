import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { rotateIfNeeded } from "../rotate.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 3;

export interface InboundRecord {
  time: string;
  platform: string;
  body: unknown;
}

/**
 * 收訊先落地（A2）：webhook 回 200 之前，先把原始 payload 寫入
 * data/inbound-queue.jsonl。行程在回 200 後、處理前崩潰時，
 * 訊息仍可從此檔追溯（完整 inbox/replay 待統一儲存層 A6 後實作）。
 */
export function persistInbound(platform: string, body: unknown): void {
  try {
    mkdirSync(dirname(config.inboundQueuePath), { recursive: true });
    const record: InboundRecord = {
      time: new Date().toISOString(),
      platform,
      body: body ?? null,
    };
    appendFileSync(config.inboundQueuePath, `${JSON.stringify(record)}\n`);
    rotateIfNeeded(config.inboundQueuePath, MAX_BYTES, MAX_FILES);
  } catch (error) {
    // 落地失敗不應擋住收訊主流程，只記錄。
    logger.warn("收訊落地失敗", { platform, error: String(error) });
  }
}

/** 開機時回報未消化的落地收訊筆數（供維運注意）。 */
export function countPersistedInbound(): number {
  try {
    if (!existsSync(config.inboundQueuePath)) return 0;
    return readFileSync(config.inboundQueuePath, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
