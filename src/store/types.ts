/**
 * 統一儲存層介面（A6 / NEXT3 Phase 1）。
 * 兩個實作：
 * - JsonlStore：與既有 JSONL 檔完全相容（測試、逃生口 STORAGE_KIND=jsonl）
 * - SqliteStore：node:sqlite（Node ≥ 22.13 內建，零依賴），可查詢、可 DELETE
 * 呼叫端（messages / stats / deadletter）只依賴此介面。
 */

export type StoreTable = "messages" | "sends" | "deadletter";

/** groupCount 允許的欄位白名單（防 SQL 注入／語意一致，兩個實作共用）。 */
export const GROUP_KEYS = new Set(["type", "platform", "kind"]);

export type StoreRow = Record<string, unknown>;

export interface StoreQueryOptions {
  /** 不分大小寫的包含搜尋（比對 haystack 或整列字串化）。 */
  search?: string;
  /** 對話欄位包含。 */
  chat?: string;
  /** 平台精確過濾（sends）。 */
  platform?: string;
  /** 只回 time >= 此值的列。 */
  sinceIso?: string;
  /** 只回 `time` 的日期部分（YYYY-MM-DD）>= 此值的列。 */
  sinceDate?: string;
  /** 只回 `time` 的日期部分（YYYY-MM-DD）<= 此值的列。 */
  untilDate?: string;
  /** 只回 `time` 解析出的 epoch 毫秒 >= 此值的列（含該時點，比 sinceDate 細到時分秒）。 */
  sinceTsMs?: number;
  /** 只回 `time` 解析出的 epoch 毫秒 <= 此值的列（含該時點）。 */
  untilTsMs?: number;
  /** 依 `chatType` 過濾（messages 表專用：平台代號，如 line／telegram／whatsapp）。 */
  chatType?: string;
  /** 預設 true（新到舊）。 */
  orderDesc?: boolean;
  /** 預設 1000，最少 1。 */
  limit?: number;
}

export interface StorePruneOptions {
  /** 刪除 time 早於 N 天的列；0 或省略 = 不依時間修剪。 */
  retentionDays?: number;
}

export interface StoreCounts {
  total: number;
  ok: number;
  fail: number;
}

export interface Store {
  readonly kind: "jsonl" | "sqlite";
  /** 寫入一筆（同時維持 JSONL 流水或轉移後的檔案行為，見各實作）。 */
  append(table: StoreTable, row: StoreRow): void;
  /** 查詢（新到舊為主）；jsonl 掃檔、sqlite 走索引。 */
  query(table: StoreTable, opts?: StoreQueryOptions): StoreRow[];
  /** 計數與成功/失敗統計（sends 表用；platform 過濾可選）。 */
  count(table: StoreTable, opts?: { platform?: string }): StoreCounts;
  /** 依欄位群組計數（sends.group by type）。 */
  groupCount(table: StoreTable, key: string, opts?: { platform?: string }): Record<string, number>;
  /** 依時間保留政策修剪；回傳刪除列數。 */
  prune(table: StoreTable, opts: StorePruneOptions): number;
  /** 清空該表（含對應 JSONL 流水檔）；回傳是否真的刪了檔案。 */
  purge(table: StoreTable): number;
  /** 關閉資源（sqlite handle）。 */
  close(): void;
}
