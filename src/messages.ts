import { config } from "./config.js";
import { logger } from "./logger.js";
import { getStore } from "./store/index.js";

export interface ReceivedMessage {
  time: string;
  fromMid: string;
  fromName: string;
  chatMid: string;
  chatType: string;
  text: string;
  /** 平台與原始訊息識別（與 dispatch 去重共用，I6/H6）。 */
  platform?: string;
  messageId?: string;
}

const LIMIT = 300;

const buffer: ReceivedMessage[] = [];

function loadRing(): void {
  buffer.length = 0;
  const rows = getStore().query("messages", { limit: LIMIT, orderDesc: false }) as unknown as ReceivedMessage[];
  for (const row of rows) buffer.push(row);
  logger.info("已載入訊息記錄", { count: buffer.length });
}

export function initMessages(): void {
  if (!config.messagesPersist) return;
  try {
    loadRing();
  } catch (error) {
    logger.warn("載入訊息記錄失敗", { error: String(error) });
  }
}

/** 設定變更後呼叫：若開啟持久化則重讀（覆寫語義，避免視窗膨脹）。 */
export function reloadMessages(): void {
  if (config.messagesPersist) {
    buffer.length = 0;
    try {
      loadRing();
    } catch (error) {
      logger.warn("載入訊息記錄失敗", { error: String(error) });
    }
  }
}

/**
 * 依保留政策修剪（I1）：刪除早於 retentionDays 的紀錄（儲存層 + 記憶體視窗）。
 * retentionDays <= 0 表示不修剪。回傳刪除筆數。
 */
export function pruneMessages(retentionDays = config.messagesRetentionDays): { memory: number; file: number } {
  const result = { memory: 0, file: 0 };
  if (!(retentionDays > 0)) return result;
  try {
    result.file = getStore().prune("messages", { retentionDays });
  } catch (error) {
    logger.warn("修剪訊息儲存失敗", { error: String(error) });
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const before = buffer.length;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const t = Date.parse(buffer[i].time);
    if (Number.isNaN(t) || t < cutoff) buffer.splice(i, 1);
  }
  result.memory = before - buffer.length;
  if (result.memory > 0 || result.file > 0) {
    logger.info("已依保留政策修剪訊息", { ...result, retentionDays });
  }
  return result;
}

/** 清除全部訊息紀錄（儲存層 + 記憶體；I1）。回傳清除筆數。 */
export function purgeMessages(): { memory: number; file: boolean } {
  const memory = buffer.length;
  buffer.length = 0;
  let file = false;
  try {
    file = getStore().purge("messages") > 0;
  } catch (error) {
    logger.warn("清除訊息儲存失敗", { error: String(error) });
  }
  logger.info("已清除訊息紀錄", { memory, file });
  return { memory, file };
}

export function recordMessage(message: ReceivedMessage): void {
  buffer.push(message);
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
  if (!config.messagesPersist) return;
  try {
    getStore().append("messages", message as unknown as Record<string, unknown>);
  } catch (error) {
    logger.warn("寫入訊息記錄失敗", { error: String(error) });
  }
}

export function getMessages(): ReceivedMessage[] {
  return [...buffer];
}

export interface MessageQuery {
  q?: string;
  chat?: string;
  limit?: number;
}

/**
 * 關鍵字搜尋（比對時間/來源/對話/內容，不分大小寫）＋對話過濾＋筆數上限。
 * 持久化開啟時查詢儲存層（全量歷史，A6/H6 修正）；否則只搜記憶體視窗。
 */
export function searchMessages(query: MessageQuery = {}): ReceivedMessage[] {
  const q = (query.q || "").trim();
  const chat = (query.chat || "").trim();
  const limit = Math.min(Math.max(query.limit ?? 300, 1), 1000);
  if (config.messagesPersist) {
    try {
      return getStore().query("messages", {
        ...(q ? { search: q } : {}),
        ...(chat ? { chat } : {}),
        limit,
      }) as unknown as ReceivedMessage[];
    } catch (error) {
      logger.warn("查詢訊息失敗，退回記憶體視窗", { error: String(error) });
    }
  }
  const ql = q.toLowerCase();
  const cl = chat.toLowerCase();
  const out: ReceivedMessage[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const m = buffer[i];
    if (cl && m.chatMid.toLowerCase().indexOf(cl) === -1) continue;
    if (ql) {
      const hay = `${m.time} ${m.fromName} ${m.fromMid} ${m.chatMid} ${m.chatType} ${m.text}`.toLowerCase();
      if (hay.indexOf(ql) === -1) continue;
    }
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}
