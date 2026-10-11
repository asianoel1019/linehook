import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";
import { currentUser } from "./middleware/session.js";

export interface AuditEntry {
  time: string;
  ip: string;
  user: string;
  action: string;
  detail?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

function auditPath(): string {
  return `${dirname(config.settingsPath)}/audit.jsonl`;
}

/** 讀取最近 N 筆稽核紀錄（新的在前）；檔案不存在或損毀行跳過。 */
export function readAuditEntries(limit = 100): AuditEntry[] {
  const path = auditPath();
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: AuditEntry[] = [];
    for (const line of lines.slice(-Math.max(limit * 2, limit))) {
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (parsed && typeof parsed.action === "string") out.push(parsed);
      } catch {
        // 單行損毀不影響其他紀錄
      }
    }
    return out.reverse().slice(0, limit);
  } catch (error) {
    logger.warn("讀取稽核失敗", { error: String(error) });
    return [];
  }
}

/** 清空稽核紀錄（保留檔不存在時建立空檔）；回傳清除筆數。 */
export function purgeAudit(): number {
  const path = auditPath();
  let removed = 0;
  try {
    if (existsSync(path)) {
      removed = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", "utf8");
    return removed;
  } catch (error) {
    logger.warn("清除稽核失敗", { error: String(error) });
    return removed;
  }
}

/**
 * 敏感操作稽核（B9/I4）：改設定、匯出、安裝技能、改密碼、上傳、刪排程等。
 * 與一般 log 分開存放，格式固定可查。
 */
export function audit(req: Request, action: string, detail?: string): void {
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    const entry: AuditEntry = {
      time: new Date().toISOString(),
      ip: req.ip ?? "",
      user: currentUser(),
      action,
      ...(detail ? { detail } : {}),
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    rotateIfNeeded(path, MAX_BYTES, MAX_FILES);
    logger.info("稽核", { action, user: entry.user, ip: entry.ip });
  } catch (error) {
    logger.warn("寫入稽核失敗", { action, error: String(error) });
  }
}
