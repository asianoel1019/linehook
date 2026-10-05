import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";
import { formatInTz } from "./time.js";
import { recordMetric } from "./metrics.js";

export interface SendEvent {
  time: string;
  to: string;
  type: string;
  ok: boolean;
  /** 平台（line / telegram…）；舊資料沒有則視為 line。 */
  platform?: string;
}

export interface DailyStat {
  date: string;
  ok: number;
  fail: number;
  total: number;
}

export interface StatsSummary {
  total: number;
  ok: number;
  fail: number;
  successRate: number;
  byType: Record<string, number>;
  days: DailyStat[];
}

const LIMIT = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3;

const buffer: SendEvent[] = [];

export function initStats(): void {
  const path = config.statsPath;
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    buffer.length = 0;
    for (const line of lines.slice(-LIMIT)) {
      try {
        buffer.push(JSON.parse(line) as SendEvent);
      } catch {
        // skip malformed
      }
    }
    logger.info("已載入發送統計", { path, count: buffer.length });
  } catch (error) {
    logger.warn("載入發送統計失敗", { error: String(error) });
  }
}

export function recordSend(event: SendEvent): void {
  buffer.push(event);
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
  recordMetric("im_send_total", 1, {
    platform: event.platform ?? "line",
    type: event.type,
    result: event.ok ? "ok" : "fail",
  });
  try {
    mkdirSync(dirname(config.statsPath), { recursive: true });
    appendFileSync(config.statsPath, `${JSON.stringify(event)}\n`);
    rotateIfNeeded(config.statsPath, MAX_BYTES, MAX_FILES);
  } catch (error) {
    logger.warn("寫入發送統計失敗", { error: String(error) });
  }
}

function dayKey(date: Date): string {
  try {
    return formatInTz(date, config.timezone).slice(0, 10);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function getStats(days = config.statsDays, platform?: string): StatsSummary {
  const byDay = new Map<string, { ok: number; fail: number }>();
  const byType: Record<string, number> = {};
  let total = 0;
  let ok = 0;
  let fail = 0;

  for (const event of buffer) {
    if (platform && (event.platform ?? "line") !== platform) continue;
    total += 1;
    if (event.ok) ok += 1;
    else fail += 1;

    const parsed = new Date(event.time);
    const key = Number.isNaN(parsed.getTime()) ? event.time.slice(0, 10) : dayKey(parsed);
    const day = byDay.get(key) ?? { ok: 0, fail: 0 };
    if (event.ok) day.ok += 1;
    else day.fail += 1;
    byDay.set(key, day);

    byType[event.type] = (byType[event.type] ?? 0) + 1;
  }

  const daily: DailyStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const key = dayKey(date);
    const day = byDay.get(key) ?? { ok: 0, fail: 0 };
    daily.push({ date: key, ok: day.ok, fail: day.fail, total: day.ok + day.fail });
  }

  return {
    total,
    ok,
    fail,
    successRate: total > 0 ? Math.round((ok / total) * 1000) / 10 : 0,
    byType,
    days: daily,
  };
}
