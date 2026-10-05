import { config } from "./config.js";
import { logger } from "./logger.js";
import { getStore } from "./store/index.js";
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

/** 預熱儲存層（sqlite 遷移/開檔在收訊前完成）。 */
export function initStats(): void {
  try {
    getStore();
  } catch (error) {
    logger.warn("儲存層預熱失敗", { error: String(error) });
  }
}

export function recordSend(event: SendEvent): void {
  recordMetric("im_send_total", 1, {
    platform: event.platform ?? "line",
    type: event.type,
    result: event.ok ? "ok" : "fail",
  });
  try {
    getStore().append("sends", event as unknown as Record<string, unknown>);
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

/**
 * 統計（A6 修正）：總數/成功/失敗與類型分組走全期聚合（不再只算記憶體最後 5000 行），
 * 日分組只掃描 days 窗口內的列（有索引）。
 */
export function getStats(days = config.statsDays, platform?: string): StatsSummary {
  const opts = platform ? { platform } : undefined;
  const store = getStore();
  const { total, ok, fail } = store.count("sends", opts);
  const byType = store.groupCount("sends", "type", opts);

  // 窗口多留 1 天緩衝，涵蓋時區偏移造成的跨日。
  const sinceIso = new Date(Date.now() - (days + 1) * 24 * 60 * 60 * 1000).toISOString();
  const rows = store.query("sends", {
    ...(platform ? { platform } : {}),
    sinceIso,
    orderDesc: false,
    limit: 100000,
  });

  const byDay = new Map<string, { ok: number; fail: number }>();
  for (const event of rows) {
    const parsed = new Date(String(event.time ?? ""));
    const key = Number.isNaN(parsed.getTime())
      ? String(event.time ?? "").slice(0, 10)
      : dayKey(parsed);
    const day = byDay.get(key) ?? { ok: 0, fail: 0 };
    if (event.ok === true || event.ok === 1) day.ok += 1;
    else day.fail += 1;
    byDay.set(key, day);
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
