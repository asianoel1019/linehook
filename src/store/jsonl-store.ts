import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { rotateIfNeeded } from "../rotate.js";
import type { Store, StoreCounts, StorePruneOptions, StoreQueryOptions, StoreRow, StoreTable } from "./types.js";
import { GROUP_KEYS } from "./types.js";

const ROTATE_LIMITS: Record<StoreTable, { maxBytes: number; maxFiles: number }> = {
  messages: { maxBytes: 5 * 1024 * 1024, maxFiles: 3 },
  sends: { maxBytes: 2 * 1024 * 1024, maxFiles: 3 },
  deadletter: { maxBytes: 5 * 1024 * 1024, maxFiles: 3 },
};

/** 各表對應的 JSONL 路徑（沿用既有 .env 設定，不新增檔案語意）。 */
export function tablePath(table: StoreTable): string {
  switch (table) {
    case "messages":
      return config.messagesPath;
    case "sends":
      return config.statsPath;
    case "deadletter":
      return config.deadletterPath;
  }
}

export function readJsonl(path: string): StoreRow[] {
  if (!existsSync(path)) return [];
  const out: StoreRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as StoreRow);
    } catch {
      // 損毀行略過
    }
  }
  return out;
}

function hayOf(row: StoreRow): string {
  return [row.time, row.fromName, row.fromMid, row.chatMid, row.chatType, row.text]
    .map((v) => String(v ?? ""))
    .join(" ")
    .toLowerCase();
}

function matches(row: StoreRow, opts?: StoreQueryOptions): boolean {
  if (!opts) return true;
  if (opts.sinceIso && !(String(row.time) >= opts.sinceIso)) return false;
  const day = String(row.time ?? "").slice(0, 10);
  if (opts.sinceDate && day < opts.sinceDate) return false;
  if (opts.untilDate && day > opts.untilDate) return false;
  if (opts.chatType && String(row.chatType ?? "") !== opts.chatType) return false;
  if (opts.platform && String(row.platform ?? "line") !== opts.platform) return false;
  if (opts.chat && !String(row.chatMid ?? "").toLowerCase().includes(opts.chat.toLowerCase())) return false;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    const hay = typeof row.hay === "string" ? row.hay : hayOf(row);
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sortLimit(rows: StoreRow[], opts?: StoreQueryOptions): StoreRow[] {
  const desc = opts?.orderDesc !== false;
  const limit = Math.min(Math.max(opts?.limit ?? 1000, 1), 100000);
  const out = [...rows];
  out.sort((a, b) => {
    const ta = String(a.time ?? "");
    const tb = String(b.time ?? "");
    if (ta === tb) return 0;
    return desc ? (ta < tb ? 1 : -1) : ta < tb ? -1 : 1;
  });
  return out.slice(0, limit);
}

/** 通用篩選＋排序（messages 搜尋與 send 窗口查詢共用）。 */
export function filterRows(rows: StoreRow[], opts?: StoreQueryOptions): StoreRow[] {
  return sortLimit(rows.filter((row) => matches(row, opts)), opts);
}

export class JsonlStore implements Store {
  readonly kind = "jsonl" as const;

  append(table: StoreTable, row: StoreRow): void {
    const path = tablePath(table);
    if (table === "messages" && typeof row.hay !== "string") {
      row = { ...row, hay: hayOf(row) };
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(row)}\n`);
      const limits = ROTATE_LIMITS[table];
      rotateIfNeeded(path, limits.maxBytes, limits.maxFiles);
    } catch {
      // 檔案寫入失敗不影響主流程（與既有行為一致）
    }
  }

  query(table: StoreTable, opts?: StoreQueryOptions): StoreRow[] {
    return filterRows(readJsonl(tablePath(table)), opts);
  }

  count(table: StoreTable, opts?: { platform?: string }): StoreCounts {
    let total = 0;
    let ok = 0;
    for (const row of readJsonl(tablePath(table))) {
      if (opts?.platform && String(row.platform ?? "line") !== opts.platform) continue;
      total += 1;
      if (row.ok === true || row.ok === 1) ok += 1;
    }
    return { total, ok, fail: total - ok };
  }

  groupCount(table: StoreTable, key: string, opts?: { platform?: string }): Record<string, number> {
    if (!GROUP_KEYS.has(key)) return {};
    const out: Record<string, number> = {};
    for (const row of readJsonl(tablePath(table))) {
      if (opts?.platform && String(row.platform ?? "line") !== opts.platform) continue;
      const k = String(row[key] ?? "unknown");
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  prune(table: StoreTable, opts: StorePruneOptions): number {
    if (!(opts.retentionDays && opts.retentionDays > 0)) return 0;
    const path = tablePath(table);
    if (!existsSync(path)) return 0;
    const cutoff = Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000;
    const rows = readJsonl(path);
    const kept: StoreRow[] = [];
    let removed = 0;
    for (const row of rows) {
      const t = Date.parse(String(row.time ?? ""));
      if (!Number.isNaN(t) && t < cutoff) removed += 1;
      else kept.push(row);
    }
    if (removed > 0) {
      const tmp = `${path}.tmp`;
      const bak = `${path}.pruned.bak`;
      mkdirSync(dirname(path), { recursive: true });
      const content = kept.length > 0 ? kept.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
      try {
        appendFileSync(tmp, content, "utf8");
        rmSync(bak, { force: true });
        renameSync(path, bak);
        renameSync(tmp, path);
      } catch {
        rmSync(path, { force: true });
        appendFileSync(path, content, "utf8");
        rmSync(tmp, { force: true });
      }
    }
    return removed;
  }

  purge(table: StoreTable): number {
    const path = tablePath(table);
    const existed = existsSync(path);
    rmSync(path, { force: true });
    return existed ? 1 : 0;
  }

  close(): void {
    // jsonl 無需釋放
  }
}
