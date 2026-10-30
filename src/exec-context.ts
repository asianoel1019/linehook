import { AsyncLocalStorage } from "node:async_hooks";

/**
 * P2 執行上下文：用 AsyncLocalStorage 帶「現在是哪支技能／哪條追蹤」，
 * 讓底層（net 出站統計、logger、trace 事件）不必改呼叫端就能知道歸屬。
 * AsyncLocalStorage 會穿透 await，技能內部再呼叫其他模組也帶得過去。
 */

export interface ExecContext {
  /** 目前執行中的技能 id（沒有的話是 undefined）。 */
  skillId?: string;
  /** 一則收訊的追蹤 id（同一則訊息內的所有事件共用）。 */
  traceId?: string;
  /** 平台名稱。 */
  platform?: string;
}

const storage = new AsyncLocalStorage<ExecContext>();

/** 在指定上下文內執行（巢狀時內層覆蓋外層的同名字段）。 */
export function runWithExecContext<T>(ctx: ExecContext, fn: () => T): T {
  const outer = storage.getStore();
  const merged: ExecContext = { ...(outer ?? {}), ...ctx };
  return storage.run(merged, fn);
}

/** 目前上下文（沒有就空物件）。 */
export function currentExecContext(): ExecContext {
  return storage.getStore() ?? {};
}
