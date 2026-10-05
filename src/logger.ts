import { appendFile, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { rotateIfNeeded, rotateDailyIfNeeded } from "./rotate.js";
import { nowIso } from "./time.js";
import type { LogEntry, LogLevel } from "./types.js";

const buffer: LogEntry[] = [];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function levelEnabled(level: LogLevel): boolean {
  const configured = (config.logLevel || "info").toLowerCase();
  const threshold = LEVEL_ORDER[configured as LogLevel] ?? LEVEL_ORDER.info;
  return LEVEL_ORDER[level] >= threshold;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!levelEnabled(level)) return;
  const entry: LogEntry = {
    time: nowIso(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };

  buffer.push(entry);
  if (buffer.length > config.logLimit) {
    buffer.splice(0, buffer.length - config.logLimit);
  }

  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  const line = `[${entry.time}] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === "error") console.error(line);
  else console.log(line);

  // C7：寫入失敗要回報（至少 stderr），不要空 callback 吞掉。
  appendFile(config.logFile, `${line}\n`, (error) => {
    if (error) console.error(`[logger] 寫入 log 檔失敗: ${String(error)}`);
  });
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
  getRecent: (): LogEntry[] => [...buffer],
};

export function initLogger(): void {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
  } catch {
    // ignore
  }
  const tick = (): void => {
    rotateIfNeeded(config.logFile, config.logMaxBytes, config.logMaxFiles);
    rotateDailyIfNeeded(config.logFile, config.logMaxFiles);
  };
  tick();
  setInterval(tick, 60_000).unref();
}
