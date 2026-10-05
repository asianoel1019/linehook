import { appendFileSync, mkdirSync } from "node:fs";
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
