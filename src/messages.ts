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
  /** 起始日（YYYY-MM-DD，含當日）；相容 YYYY/MM/DD。 */
  since?: string;
  /** 結束日（YYYY-MM-DD，含當日）；相容 YYYY/MM/DD。 */
  until?: string;
  /** 起始時間（ISO 8601 或 epoch 毫秒，含該時點）；精確到時分秒，可與 since 並用。 */
  sinceTs?: string;
  /** 結束時間（ISO 8601 或 epoch 毫秒，含該時點）。 */
  untilTs?: string;
  /** 平台代號（chatType：line／telegram／whatsapp／teams／discord）。 */
  chatType?: string;
  limit?: number;
}

/** 把日期輸入正規化為 YYYY-MM-DD；無效回空字串（視為不設限）。 */
function normalizeDay(value: string): string {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(value ?? "").trim());
  if (!m) return "";
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
}

/** 把時間輸入正規化為 epoch 毫秒；無效回 undefined（視為不設限）。ISO 8601 或 ≥10 位純數字毫秒。 */
function normalizeTs(value: string | undefined): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^\d{10,}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * 關鍵字搜尋（比對時間/來源/對話/內容，不分大小寫）＋對話過濾＋筆數上限。
 * 持久化開啟時查詢儲存層（全量歷史，A6/H6 修正）；否則只搜記憶體視窗。
 */
export function searchMessages(query: MessageQuery = {}): ReceivedMessage[] {
  const q = (query.q || "").trim();
  const chat = (query.chat || "").trim();
  const since = normalizeDay(query.since || "");
  const until = normalizeDay(query.until || "");
  const sinceTs = normalizeTs(query.sinceTs);
  const untilTs = normalizeTs(query.untilTs);
  const chatType = (query.chatType || "").trim();
  // limit <= 0 或未設＝預設 300（注意：Number("") === 0，不可直接拿來當上限）。
  const rawLimit = Number(query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 300;
  if (config.messagesPersist) {
    try {
      return getStore().query("messages", {
        ...(q ? { search: q } : {}),
        ...(chat ? { chat } : {}),
        ...(since ? { sinceDate: since } : {}),
        ...(until ? { untilDate: until } : {}),
        ...(sinceTs !== undefined ? { sinceTsMs: sinceTs } : {}),
        ...(untilTs !== undefined ? { untilTsMs: untilTs } : {}),
        ...(chatType ? { chatType } : {}),
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
    const day = String(m.time ?? "").slice(0, 10);
    if (since && day < since) continue;
    if (until && day > until) continue;
    if (sinceTs !== undefined || untilTs !== undefined) {
      const t = Date.parse(String(m.time ?? ""));
      if (!Number.isFinite(t)) continue;
      if (sinceTs !== undefined && t < sinceTs) continue;
      if (untilTs !== undefined && t > untilTs) continue;
    }
    if (chatType && (m.chatType ?? "") !== chatType) continue;
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
