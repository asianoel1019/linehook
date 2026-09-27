import { appendFile, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { rotateIfNeeded } from "./rotate.js";
import type { LogEntry, LogLevel } from "./types.js";

const buffer: LogEntry[] = [];

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    time: new Date().toISOString(),
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

  appendFile(config.logFile, `${line}\n`, () => {});
}

export const logger = {
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
  setInterval(() => rotateIfNeeded(config.logFile, config.logMaxBytes, config.logMaxFiles), 60_000).unref();
}
