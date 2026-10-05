import { logger } from "../logger.js";

/**
 * 收訊去重（A1）：平台重送同一則訊息時只處理一次。
 * key 為 `${platform}:${messageId}`，TTL 24 小時，預設上限 20000 筆（FIFO 驅逐）。
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDS = 20000;

const seen = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, time] of seen) {
    if (time < cutoff) seen.delete(key);
  }
}, 60_000).unref();

/**
 * 若此 (platform, messageId) 已處理過回傳 true（呼叫端應略過）。
 * messageId 為空時不去重（回傳 false）。
 */
export function seenInbound(platform: string, messageId: string | undefined): boolean {
  if (!messageId) return false;
  const key = `${platform}:${messageId}`;
  if (seen.has(key)) {
    logger.warn("重複收訊已略過", { platform, messageId });
    return true;
  }
  seen.set(key, Date.now());
  if (seen.size > MAX_IDS) {
    const oldest = seen.keys().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  return false;
}
