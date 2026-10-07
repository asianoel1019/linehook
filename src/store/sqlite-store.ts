import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readJsonl, tablePath } from "./jsonl-store.js";
import type { Store, StoreCounts, StorePruneOptions, StoreQueryOptions, StoreRow, StoreTable } from "./types.js";
import { GROUP_KEYS } from "./types.js";

/** 每次開機只需建立一次的 schema。 */
const DDL: Record<StoreTable, string> = {
  messages: `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      fromMid TEXT DEFAULT '', fromName TEXT DEFAULT '', chatMid TEXT DEFAULT '',
      chatType TEXT DEFAULT '', text TEXT DEFAULT '', hay TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chatMid);`,
  sends: `
    CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      target TEXT DEFAULT '',
      type TEXT DEFAULT '',
      ok INTEGER DEFAULT 1,
      platform TEXT DEFAULT 'line'
    );
    CREATE INDEX IF NOT EXISTS idx_sends_time ON sends(time);
    CREATE INDEX IF NOT EXISTS idx_sends_platform ON sends(platform);`,
  deadletter: `
    CREATE TABLE IF NOT EXISTS deadletter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      platform TEXT DEFAULT '', kind TEXT DEFAULT '',
      target TEXT DEFAULT '', summary TEXT DEFAULT '', error TEXT DEFAULT '',
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deadletter_time ON deadletter(time);`,
};

const TABLES: StoreTable[] = ["messages", "sends", "deadletter"];

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** 表缺欄位時補上（跨版本升級用）。 */
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info("SQLite 已加掛欄位", { table, column });
    }
  } catch (error) {
    logger.warn("SQLite 欄位升級失敗", { table, column, error: String(error) });
  }
}

function rowToStoreRow(table: StoreTable, row: Record<string, unknown>): StoreRow {
  if (table === "sends") {
    let to = "";
    try {
      const parsed = JSON.parse(String(row.target ?? ""));
      to = Array.isArray(parsed) ? parsed.join(",") : String(parsed);
    } catch {
      to = String(row.target ?? "");
    }
    return {
      time: String(row.time ?? ""),
      to,
      type: String(row.type ?? ""),
      ok: row.ok === 1 || row.ok === true,
      platform: String(row.platform ?? "line"),
    };
  }
  if (table === "deadletter") {
    let to: string[] = [];
    try {
      const parsed = JSON.parse(String(row.target ?? "[]"));
      if (Array.isArray(parsed)) to = parsed.map((x) => String(x));
    } catch {
      to = String(row.target ?? "").split("、").filter(Boolean);
    }
    let payload: unknown;
    if (typeof row.payload === "string" && row.payload) {
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = undefined;
      }
    }
    return {
      time: String(row.time ?? ""),
      platform: String(row.platform ?? ""),
      kind: String(row.kind ?? ""),
      to,
      summary: String(row.summary ?? ""),
      error: String(row.error ?? ""),
      ...(payload !== undefined ? { payload } : {}),
    };
  }
  return {
    time: String(row.time ?? ""),
    fromMid: String(row.fromMid ?? ""),
    fromName: String(row.fromName ?? ""),
    chatMid: String(row.chatMid ?? ""),
    chatType: String(row.chatType ?? ""),
    text: String(row.text ?? ""),
    hay: String(row.hay ?? ""),
  };
}

function hayOf(row: StoreRow): string {
  return [row.time, row.fromName, row.fromMid, row.chatMid, row.chatType, row.text]
    .map((v) => String(v ?? ""))
    .join(" ")
    .toLowerCase();
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private db: DatabaseSync | null = null;

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(config.dbPath), { recursive: true });
    const db = new DatabaseSync(config.dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    for (const table of TABLES) db.exec(DDL[table]);
    // 既有 DB 的欄位加掛（CREATE TABLE IF NOT EXISTS 不會補欄位）。
    ensureColumn(db, "deadletter", "payload", "TEXT");
    this.db = db;
    this.migrateFromJsonl(db);
    logger.info("SQLite 儲存層已開啟", { path: config.dbPath, tables: TABLES.length });
    return db;
  }

  /** 一次性遷移：表為空時把既有 JSONL 匯入，匯入後改名 .migrated（避免重複與持續膨脹）。 */
  private migrateFromJsonl(db: DatabaseSync): void {
    for (const table of TABLES) {
      const { rows: hasRows } = db.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).get() as { rows: number };
      if (hasRows > 0) continue;
      const path = tablePath(table);
      if (!existsSync(path)) continue;
      const source = readJsonl(path);
      if (source.length === 0) continue;
      let migrated = 0;
      for (const row of source) {
        if (this.insert(db, table, row)) migrated += 1;
      }
      try {
        renameSync(path, `${path}.migrated`);
      } catch {
        // 改名失敗不阻擋開機（下次遷移會因表已非空而跳過）
      }
      logger.info("已從 JSONL 遷移至 SQLite", { table, migrated, path });
    }
  }

  private insert(db: DatabaseSync, table: StoreTable, row: StoreRow): boolean {
    try {
      if (table === "messages") {
        const hay = typeof row.hay === "string" ? row.hay : hayOf(row);
        db.prepare(
          "INSERT INTO messages (time, fromMid, fromName, chatMid, chatType, text, hay) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          String(row.time ?? ""),
          String(row.fromMid ?? ""),
          String(row.fromName ?? ""),
          String(row.chatMid ?? ""),
          String(row.chatType ?? ""),
          String(row.text ?? ""),
          hay,
        );
        return true;
      }
      if (table === "sends") {
        db.prepare("INSERT INTO sends (time, target, type, ok, platform) VALUES (?, ?, ?, ?, ?)").run(
          String(row.time ?? ""),
          Array.isArray(row.to) ? JSON.stringify(row.to) : JSON.stringify([String(row.to ?? "")]),
          String(row.type ?? ""),
          row.ok === true || row.ok === 1 ? 1 : 0,
          String(row.platform ?? "line"),
        );
        return true;
      }
      const payloadJson = row.payload === undefined ? null : JSON.stringify(row.payload);
      db.prepare(
        "INSERT INTO deadletter (time, platform, kind, target, summary, error, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        String(row.time ?? ""),
        String(row.platform ?? ""),
        String(row.kind ?? ""),
        Array.isArray(row.to) ? JSON.stringify(row.to) : JSON.stringify([String(row.to ?? "")]),
        String(row.summary ?? ""),
        String(row.error ?? ""),
        payloadJson,
      );
      return true;
    } catch (error) {
      logger.warn("SQLite 寫入失敗", { table, error: String(error) });
      return false;
    }
  }

  append(table: StoreTable, row: StoreRow): void {
    const db = this.open();
    this.insert(db, table, row);
  }

  query(table: StoreTable, opts?: StoreQueryOptions): StoreRow[] {
    const db = this.open();
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (opts?.sinceIso) {
      where.push("time >= ?");
      params.push(opts.sinceIso);
    }
    if (opts?.sinceDate) {
      where.push("substr(time, 1, 10) >= ?");
      params.push(opts.sinceDate);
    }
    if (opts?.untilDate) {
      where.push("substr(time, 1, 10) <= ?");
      params.push(opts.untilDate);
    }
    if (opts?.chatType && table === "messages") {
      where.push("chatType = ?");
      params.push(opts.chatType);
    }
    if (opts?.platform) {
      where.push(table === "sends" ? "platform = ?" : "platform = ?");
      params.push(opts.platform);
    }
    if (opts?.chat) {
      where.push("chatMid LIKE ? ESCAPE '\\'");
      params.push(likePattern(opts.chat));
    }
    if (opts?.search) {
      const q = opts.search.toLowerCase();
      if (table === "messages") {
        where.push("hay LIKE ? ESCAPE '\\'");
        params.push(likePattern(q));
      } else {
        where.push("(COALESCE(target,'') || ' ' || COALESCE(summary,'') || ' ' || COALESCE(error,'') || ' ' || COALESCE(kind,'')) LIKE ? ESCAPE '\\'");
        params.push(likePattern(q));
      }
    }
    const limit = Math.min(Math.max(opts?.limit ?? 1000, 1), 100000);
    const desc = opts?.orderDesc !== false;
    const sql = `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY time ${desc ? "DESC" : "ASC"}, id ${desc ? "DESC" : "ASC"} LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => rowToStoreRow(table, row));
  }

  count(table: StoreTable, opts?: { platform?: string }): StoreCounts {
    const db = this.open();
    const where = opts?.platform ? " WHERE platform = ?" : "";
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok FROM ${table}${where}`,
      )
      .get(...(opts?.platform ? [opts.platform] : [])) as { total: number; ok: number | null };
    const total = row?.total ?? 0;
    const ok = row?.ok ?? 0;
    return { total, ok, fail: total - ok };
  }

  groupCount(table: StoreTable, key: string, opts?: { platform?: string }): Record<string, number> {
    if (!GROUP_KEYS.has(key)) return {};
    const db = this.open();
    const where = opts?.platform ? " WHERE platform = ?" : "";
    const rows = db
      .prepare(`SELECT ${key} AS k, COUNT(*) AS n FROM ${table}${where} GROUP BY ${key}`)
      .all(...(opts?.platform ? [opts.platform] : [])) as Array<{ k: string; n: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row.k ?? "unknown")] = Number(row.n ?? 0);
    return out;
  }

  prune(table: StoreTable, opts: StorePruneOptions): number {
    if (!(opts.retentionDays && opts.retentionDays > 0)) return 0;
    const db = this.open();
    const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const { changes } = db.prepare(`DELETE FROM ${table} WHERE time < ?`).run(cutoff);
    const removed = Number(changes ?? 0);
    if (removed > 0) logger.info("SQLite 依保留政策修剪", { table, removed, retentionDays: opts.retentionDays });
    return removed;
  }

  purge(table: StoreTable): number {
    const db = this.open();
    const { changes } = db.prepare(`DELETE FROM ${table}`).run();
    const removed = Number(changes ?? 0);
    // 同步移除對應的流水檔與遷移封存，避免 PII 殘留。
    const path = tablePath(table);
    rmSync(path, { force: true });
    rmSync(`${path}.migrated`, { force: true });
    return removed;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore double close
      }
      this.db = null;
    }
  }
}
