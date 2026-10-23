import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { formatInTz } from "./time.js";

/**
 * P2 技能健康／使用分析的持久化執行日誌。
 *互動與排程兩條漏斗每次執行各記一筆（成功／失敗＋錯因），每日一桶供近 7 日統計。
 * 高頻技能（auto-reply 這種每則訊息都跑）只改內存，5 秒防抖落檔，避免每則訊息打一次檔。
 */

export interface SkillDayStat {
  /** YYYY-MM-DD（config.timezone 牆鐘日）。 */
  date: string;
  run: number;
  fail: number;
}

export interface SkillJournal {
  totalRun: number;
  totalFail: number;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError?: string;
  consecFails: number;
  lastSuccessAt: number | null;
  /** 依日期升冪，最多保留 8 天。 */
  days: SkillDayStat[];
}

interface SkillStatsFile {
  skills: Record<string, SkillJournal>;
}

const MAX_DAYS = 8;

let overridePath: string | null = null;
/** 測試用：改存檔位置（下次讀寫生效；請同時呼叫 resetSkillStatsCache 隔離內存）。 */
export function setSkillStatsPath(path: string | null): void {
  overridePath = path;
}

function filePath(): string {
  if (overridePath) return overridePath;
  return resolve(config.schedulesPath, "..", "skill-stats.json");
}

function blankJournal(): SkillJournal {
  return {
    totalRun: 0,
    totalFail: 0,
    lastAt: null,
    lastOk: null,
    consecFails: 0,
    lastSuccessAt: null,
    days: [],
  };
}

function normalizeJournal(raw: unknown): SkillJournal {
  const j = blankJournal();
  if (!raw || typeof raw !== "object") return j;
  const r = raw as Partial<SkillJournal>;
  if (typeof r.totalRun === "number" && r.totalRun >= 0) j.totalRun = Math.floor(r.totalRun);
  if (typeof r.totalFail === "number" && r.totalFail >= 0) j.totalFail = Math.floor(r.totalFail);
  if (typeof r.lastAt === "number") j.lastAt = r.lastAt;
  if (typeof r.lastOk === "boolean") j.lastOk = r.lastOk;
  if (typeof r.lastError === "string" && r.lastError) j.lastError = r.lastError.slice(0, 200);
  if (typeof r.consecFails === "number" && r.consecFails >= 0) j.consecFails = Math.floor(r.consecFails);
  if (typeof r.lastSuccessAt === "number") j.lastSuccessAt = r.lastSuccessAt;
  if (Array.isArray(r.days)) {
    for (const d of r.days) {
      if (!d || typeof d !== "object") continue;
      const row = d as Partial<SkillDayStat>;
      if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
      j.days.push({
        date: row.date,
        run: typeof row.run === "number" && row.run >= 0 ? Math.floor(row.run) : 0,
        fail: typeof row.fail === "number" && row.fail >= 0 ? Math.floor(row.fail) : 0,
      });
    }
    j.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (j.days.length > MAX_DAYS) j.days = j.days.slice(j.days.length - MAX_DAYS);
  }
  return j;
}

let cache: SkillStatsFile | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

function load(): SkillStatsFile {
  if (cache) return cache;
  try {
    if (!existsSync(filePath())) cache = { skills: {} };
    else {
      const raw = JSON.parse(readFileSync(filePath(), "utf8")) as { skills?: Record<string, unknown> };
      const skills: Record<string, SkillJournal> = {};
      if (raw && typeof raw.skills === "object" && raw.skills) {
        for (const [id, j] of Object.entries(raw.skills)) skills[id] = normalizeJournal(j);
      }
      cache = { skills };
    }
  } catch (error) {
    logger.warn("讀取技能執行日誌失敗，用空表", { error: String(error) });
    cache = { skills: {} };
  }
  return cache;
}

function saveNow(): void {
  if (!cache) {
    dirty = false;
    return;
  }
  try {
    const path = filePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    logger.warn("儲存技能執行日誌失敗", { error: String(error) });
  }
  dirty = false;
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    saveNow();
  }, 5000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

/** 立刻落檔（測試用；平時由防抖 timer 處理）。 */
export function flushSkillStats(): void {
  if (!dirty) return;
  saveNow();
}

/** 測試用：丟掉內存＋取消 pending 落檔（換檔隔離）。 */
export function resetSkillStatsCache(): void {
  cache = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** 記一筆執行（互動與排程兩漏斗共用）。回傳該技能最新日誌副本。 */
export function recordSkillRun(skillId: string, ok: boolean, error?: string): SkillJournal {
  const store = load();
  const j = store.skills[skillId] ?? blankJournal();
  const today = formatInTz(new Date()).slice(0, 10);
  j.totalRun += 1;
  if (!ok) j.totalFail += 1;
  j.lastAt = Date.now();
  j.lastOk = ok;
  if (ok) {
    j.consecFails = 0;
    j.lastSuccessAt = j.lastAt;
    delete j.lastError;
  } else {
    j.consecFails += 1;
    if (error) j.lastError = error.slice(0, 200);
  }
  let bucket = j.days.find((d) => d.date === today);
  if (!bucket) {
    bucket = { date: today, run: 0, fail: 0 };
    j.days.push(bucket);
  }
  bucket.run += 1;
  if (!ok) bucket.fail += 1;
  j.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (j.days.length > MAX_DAYS) j.days = j.days.slice(j.days.length - MAX_DAYS);
  store.skills[skillId] = j;
  scheduleFlush();
  return structuredClone(j);
}

export interface SkillUsageRow {
  id: string;
  runs7d: number;
  fails7d: number;
  /** 失敗率％（一位小數；無執行為 0）。 */
  failRate: number;
  lastAt: number | null;
  totalRuns: number;
}

/** 近 7 日（含今天）使用統計，供 /skills/usage.json。 */
export function getSkillUsage(): SkillUsageRow[] {
  const store = load();
  const cutoff = formatInTz(new Date(Date.now() - 6 * 86400_000)).slice(0, 10);
  return Object.entries(store.skills).map(([id, j]) => {
    let runs7d = 0;
    let fails7d = 0;
    for (const d of j.days) {
      if (d.date < cutoff) continue;
      runs7d += d.run;
      fails7d += d.fail;
    }
    return {
      id,
      runs7d,
      fails7d,
      failRate: runs7d > 0 ? Math.round((fails7d / runs7d) * 1000) / 10 : 0,
      lastAt: j.lastAt,
      totalRuns: j.totalRun,
    };
  });
}

/** 全部技能日誌副本，供 /skills/health 附加（被動數據，不觸發探測）。 */
export function getSkillJournals(): Record<string, SkillJournal> {
  return structuredClone(load().skills);
}
