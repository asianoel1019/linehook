import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";

export interface ReceivedMessage {
  time: string;
  fromMid: string;
  fromName: string;
  chatMid: string;
  chatType: string;
  text: string;
}

const LIMIT = 300;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

const buffer: ReceivedMessage[] = [];

function loadFromFile(): void {
  const path = config.messagesPath;
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const recent = lines.slice(-LIMIT);
    buffer.length = 0;
    for (const line of recent) {
      try {
        buffer.push(JSON.parse(line) as ReceivedMessage);
      } catch {
        // skip malformed line
      }
    }
    logger.info("已載入訊息記錄", { path, count: buffer.length });
  } catch (error) {
    logger.warn("載入訊息記錄失敗", { error: String(error) });
  }
}

export function initMessages(): void {
  if (!config.messagesPersist) return;
  loadFromFile();
}

/** 設定變更後呼叫：若開啟持久化則載入檔案內容。 */
export function reloadMessages(): void {
  if (config.messagesPersist) loadFromFile();
}

export function recordMessage(message: ReceivedMessage): void {
  buffer.push(message);
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);

  if (!config.messagesPersist) return;
  try {
    mkdirSync(dirname(config.messagesPath), { recursive: true });
    appendFileSync(config.messagesPath, `${JSON.stringify(message)}\n`);
    rotateIfNeeded(config.messagesPath, MAX_BYTES, MAX_FILES);
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

/** 關鍵字搜尋（比對時間/來源/對話/內容，不分大小寫）＋對話過濾＋筆數上限。 */
export function searchMessages(query: MessageQuery = {}): ReceivedMessage[] {
  const q = (query.q || "").trim().toLowerCase();
  const chat = (query.chat || "").trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 300, 1), 1000);
  const out: ReceivedMessage[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const m = buffer[i];
    if (chat && m.chatMid.toLowerCase().indexOf(chat) === -1) continue;
    if (q) {
      const hay = `${m.time} ${m.fromName} ${m.fromMid} ${m.chatMid} ${m.chatType} ${m.text}`.toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    }
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}
