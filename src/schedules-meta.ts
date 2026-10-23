import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface QuietHours {
  enabled: boolean;
  /** HH:mm（24h）。 */
  from: string;
  /** HH:mm（24h）；早於 from 代表跨夜。 */
  to: string;
}

export interface LastRun {
  at: number;
  ok: boolean;
  error?: string;
}

interface SchedulesMeta {
  quiet: QuietHours;
  globalMute: boolean;
  muted: Record<string, true>;
  lastRuns: Record<string, LastRun>;
}

const DEFAULTS: SchedulesMeta = {
  quiet: { enabled: false, from: "23:00", to: "07:00" },
  globalMute: false,
  muted: {},
  lastRuns: {},
};

const MAX_ENTRIES = 500;

let overridePath: string | null = null;
/** 測試用：改存檔位置（下次讀寫生效）。 */
export function setSchedulesMetaPath(path: string | null): void {
  overridePath = path;
}

function filePath(): string {
  if (overridePath) return overridePath;
  return resolve(config.schedulesPath, "..", "schedules-meta.json");
}

function normalize(raw: unknown): SchedulesMeta {
  const r = (raw ?? {}) as Partial<SchedulesMeta>;
  const hm = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : fallback;
  return {
    quiet: {
      enabled: (r.quiet as QuietHours | undefined)?.enabled === true,
      from: hm((r.quiet as QuietHours | undefined)?.from, DEFAULTS.quiet.from),
      to: hm((r.quiet as QuietHours | undefined)?.to, DEFAULTS.quiet.to),
    },
    globalMute: r.globalMute === true,
    muted:
      r.muted && typeof r.muted === "object"
        ? Object.fromEntries(Object.keys(r.muted).slice(0, MAX_ENTRIES).map((k) => [k, true as const]))
        : {},
    lastRuns:
      r.lastRuns && typeof r.lastRuns === "object"
        ? Object.fromEntries(
            Object.entries(r.lastRuns)
              .filter(([, v]) => v && typeof (v as LastRun).at === "number")
              .slice(0, MAX_ENTRIES),
          )
        : {},
  };
}

export function loadSchedulesMeta(): SchedulesMeta {
  try {
    if (!existsSync(filePath())) return structuredClone(DEFAULTS);
    return normalize(JSON.parse(readFileSync(filePath(), "utf8")));
  } catch (error) {
    logger.warn("讀取排程附屬狀態失敗，用預設值", { error: String(error) });
    return structuredClone(DEFAULTS);
  }
}

function save(meta: SchedulesMeta): void {
  try {
    const path = filePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    logger.warn("儲存排程附屬狀態失敗", { error: String(error) });
  }
}

function update(patch: (meta: SchedulesMeta) => void): SchedulesMeta {
  const meta = loadSchedulesMeta();
  patch(meta);
  save(meta);
  return meta;
}

export function setQuietHours(quiet: QuietHours): SchedulesMeta {
  return update((m) => {
    m.quiet = normalize({ quiet }).quiet;
  });
}

export function setGlobalMute(muted: boolean): SchedulesMeta {
  return update((m) => {
    m.globalMute = muted;
  });
}

export function setJobMuted(jobId: string, muted: boolean): SchedulesMeta {
  return update((m) => {
    if (muted) {
      const keys = Object.keys(m.muted);
      if (!m.muted[jobId] && keys.length >= MAX_ENTRIES) delete m.muted[keys[0]];
      m.muted[jobId] = true;
    } else {
      delete m.muted[jobId];
    }
  });
}

export function recordLastRun(jobId: string, run: LastRun): void {
  update((m) => {
    const keys = Object.keys(m.lastRuns);
    if (!m.lastRuns[jobId] && keys.length >= MAX_ENTRIES) delete m.lastRuns[keys[0]];
    m.lastRuns[jobId] = { at: run.at, ok: run.ok, ...(run.error ? { error: run.error.slice(0, 200) } : {}) };
  });
}

/** 清掉已不存在任務的 mute/lastRun（呼叫端傳入現存 id 集合）。 */
export function pruneSchedulesMeta(aliveIds: Set<string>): SchedulesMeta {
  return update((m) => {
    for (const id of Object.keys(m.muted)) if (!aliveIds.has(id)) delete m.muted[id];
    for (const id of Object.keys(m.lastRuns)) if (!aliveIds.has(id)) delete m.lastRuns[id];
  });
}
