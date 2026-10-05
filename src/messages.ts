import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** 設定變更後呼叫：若開啟持久化則重讀檔案（覆寫語義，避免視窗膨脹）。 */
export function reloadMessages(): void {
  if (config.messagesPersist) {
    buffer.length = 0;
    loadFromFile();
  }
}

/**
 * 依保留政策修剪（I1）：刪除早於 retentionDays 的紀錄。
 * retentionDays <= 0 表示不修剪。回傳實際刪除筆數。
 */
export function pruneMessages(retentionDays = config.messagesRetentionDays): { memory: number; file: number } {
  const result = { memory: 0, file: 0 };
  if (!(retentionDays > 0)) return result;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const before = buffer.length;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (Number.isNaN(new Date(buffer[i].time).getTime()) || new Date(buffer[i].time).getTime() < cutoff) {
      buffer.splice(i, 1);
    }
  }
  result.memory = before - buffer.length;
  try {
    if (existsSync(config.messagesPath)) {
      const lines = readFileSync(config.messagesPath, "utf8").split("\n").filter(Boolean);
      const kept: string[] = [];
      for (const line of lines) {
        try {
          const m = JSON.parse(line) as { time?: string };
          const t = m.time ? new Date(m.time).getTime() : NaN;
          if (!Number.isNaN(t) && t >= cutoff) kept.push(line);
          else result.file += 1;
        } catch {
          kept.push(line);
        }
      }
      if (result.file > 0) {
        const tmp = `${config.messagesPath}.tmp`;
        mkdirSync(dirname(config.messagesPath), { recursive: true });
        writeFileSync(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
        renameSync(tmp, config.messagesPath);
      }
    }
  } catch (error) {
    logger.warn("修剪訊息檔失敗", { error: String(error) });
  }
  if (result.memory > 0 || result.file > 0) {
    logger.info("已依保留政策修剪訊息", { ...result, retentionDays });
  }
  return result;
}

/** 清除全部訊息紀錄（記憶體＋檔案；I1）。回傳清除筆數。 */
export function purgeMessages(): { memory: number; file: boolean } {
  const memory = buffer.length;
  buffer.length = 0;
  let file = false;
  try {
    if (existsSync(config.messagesPath)) {
      rmSync(config.messagesPath);
      file = true;
    }
  } catch (error) {
    logger.warn("清除訊息檔失敗", { error: String(error) });
  }
  logger.info("已清除訊息紀錄", { memory, file });
  return { memory, file };
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
