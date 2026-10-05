import { config } from "../config.js";
import { logger } from "../logger.js";
import { JsonlStore } from "./jsonl-store.js";
import { SqliteStore } from "./sqlite-store.js";
import type { Store } from "./types.js";

export type { Store, StoreTable, StoreRow, StoreQueryOptions } from "./types.js";

let current: Store | null = null;
let signature = "";

function storeSignature(): string {
  return [
    config.storageKind,
    config.messagesPath,
    config.statsPath,
    config.deadletterPath,
    config.dbPath,
  ].join("|");
}

/**
 * 取得目前儲存層（單例）。路徑或 storageKind 變更時自動重建
 * （測試常在執行期改 config 路徑；Node 測試子行程以 NODE_TEST_CONTEXT
 * 預設走 jsonl，避免測試寫入資料庫與斷言檔案內容互相干擾）。
 */
export function getStore(): Store {
  const sig = storeSignature();
  if (!current || sig !== signature) {
    try {
      current?.close();
    } catch {
      // ignore
    }
    const wantsSqlite = config.storageKind === "sqlite" && !process.env.NODE_TEST_CONTEXT;
    current = wantsSqlite ? new SqliteStore() : new JsonlStore();
    signature = sig;
    logger.info("儲存層就緒", { kind: current.kind });
  }
  return current;
}

/** 開機預先建立（確保 sqlite 遷移在收訊前完成）；關機時釋放。 */
export function initStore(): Store {
  return getStore();
}

export function closeStore(): void {
  try {
    current?.close();
  } catch {
    // ignore
  }
  current = null;
  signature = "";
}
