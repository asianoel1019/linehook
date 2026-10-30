import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { rotateIfNeeded } from "./rotate.js";
import { currentExecContext, runWithExecContext } from "./exec-context.js";

/**
 * P2 端到端鏈路追蹤：一則收訊就是一條 trace（收到 → 判中哪些技能 → 轉發到哪 → 哪個失敗）。
 * 落檔 data/traces.jsonl（每則一列，含 events 陣列），Console 可展開成樹狀檢視。
 * 只記摘要（技能名、成功與否、錯因），不記完整內文以外的敏感內容。
 */

export interface TraceEvent {
  /** 毫秒時間戳。 */
  t: number;
  /** 事件類型（skill / forward / reply / fail / outbound…）。 */
  kind: string;
  skill?: string;
  detail?: string;
  ok?: boolean;
}

export interface TraceRecord {
  traceId: string;
  time: string;
  platform: string;
  chat: string;
  from: string;
  /** 訊息前 120 字（避免整句長文塞爆檔案）。 */
  text: string;
  events: TraceEvent[];
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_EVENTS = 40;

let tracePathOverride: string | null = null;

/** 測試用：改落檔位置。 */
export function setTracePath(path: string | null): void {
  tracePathOverride = path;
}

function tracePath(): string {
  if (tracePathOverride) return tracePathOverride;
  return `${dirname(config.settingsPath)}/traces.jsonl`;
}

/** 目前進行中的 trace（由 exec-context 的 traceId 對應）。 */
const active = new Map<string, TraceRecord>();

/** 產生追蹤 id（短、可讀、時間序）。 */
export function newTraceId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 開一條 trace 並回傳 id（呼叫端需在收完後呼叫 finishTrace）。 */
export function startTrace(platform: string, chat: string, from: string, text: string): string {
  const traceId = newTraceId();
  active.set(traceId, {
    traceId,
    time: new Date().toISOString(),
    platform,
    chat,
    from,
    text: String(text ?? "").slice(0, 120),
    events: [],
  });
  return traceId;
}

/** 在目前 trace 加一個事件（沒有 trace 就忽略；不影響主流程）。 */
export function traceEvent(kind: string, fields: { skill?: string; detail?: string; ok?: boolean } = {}): void {
  const { traceId } = currentExecContext();
  if (!traceId) return;
  const rec = active.get(traceId);
  if (!rec) return;
  if (rec.events.length >= MAX_EVENTS) return;
  rec.events.push({
    t: Date.now(),
    kind,
    ...(fields.skill ? { skill: fields.skill } : {}),
    ...(fields.detail ? { detail: String(fields.detail).slice(0, 200) } : {}),
    ...(fields.ok === undefined ? {} : { ok: fields.ok }),
  });
}

/** 結束並落檔（沒有 trace 就什麼都不做）。 */
export function finishTrace(): void {
  const { traceId } = currentExecContext();
  if (!traceId) return;
  const rec = active.get(traceId);
  active.delete(traceId);
  if (!rec) return;
  try {
    const path = tracePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
    rotateIfNeeded(path, MAX_BYTES, MAX_FILES);
  } catch (error) {
    logger.warn("寫入追蹤紀錄失敗", { error: String(error) });
  }
}

/** 在指定追蹤上下文內執行（讓內層事件歸到同一條 trace）。 */
export function withTrace<T>(traceId: string, fn: () => T): T {
  return runWithExecContext({ traceId }, fn);
}

/** 讀最近 N 條 trace（新的在前）。 */
export function readTraces(limit = 50): TraceRecord[] {
  try {
    const path = tracePath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: TraceRecord[] = [];
    for (const line of lines.slice(-Math.max(limit * 2, limit))) {
      try {
        const rec = JSON.parse(line) as TraceRecord;
        if (rec && typeof rec.traceId === "string") out.push(rec);
      } catch {
        // 壞行跳過
      }
    }
    return out.reverse().slice(0, limit);
  } catch (error) {
    logger.warn("讀取追蹤紀錄失敗", { error: String(error) });
    return [];
  }
}

/** 測試用：清掉進行中的 trace。 */
export function resetActiveTraces(): void {
  active.clear();
}
