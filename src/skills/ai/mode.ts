/**
 * AI 對話模式：某對話免觸發詞直問 AI 的滑動視窗狀態。
 * - key 只有 chatMid（SkillContext 本來就沒平台欄位；各平台 ID 格式天然不相撞，
 *   見 isGroupChat；限流 skillThrottled 同樣只拿 chat）。
 * - 逾時不靠 timer：下則訊息來時發現過期即視為關閉（到期通知由呼叫端決定發不發）。
 * - 純函式＋小 Map，可單元測試；上限 500 筆防爆。
 */

const activeUntil = new Map<string, number>();
const MAX_ENTRIES = 500;

/** 對話模式維持毫秒：ai 技能 sessionTtlMin 欄（字串分鐘數）；缺省 10；<=0 或非法 = 功能關閉。 */
export function aiModeTtlMs(skillConfig?: Record<string, string>): number {
  const raw = (skillConfig?.sessionTtlMin ?? "").trim();
  if (raw === "") return 10 * 60 * 1000;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 24 * 60) * 60 * 1000;
}

/** 群組開關：ai 技能 groupMode 欄是否為 on（預設 off＝僅個人對話）。 */
export function aiGroupModeOn(skillConfig?: Record<string, string>): boolean {
  return (skillConfig?.groupMode ?? "").trim().toLowerCase() === "on";
}

/** 是否啟動中（已逾時回 false；是否清除由呼叫端決定，以便到期通知）。 */
export function isAiModeActive(chat: string, now = Date.now()): boolean {
  const until = activeUntil.get(chat);
  if (until === undefined) return false;
  return until > now;
}

/** 延長（或啟動）到 now + ttlMs；ttl <= 0 或空對話不做事。 */
export function touchAiMode(chat: string, ttlMs: number, now = Date.now()): void {
  if (!chat || ttlMs <= 0) return;
  if (activeUntil.has(chat)) activeUntil.delete(chat);
  activeUntil.set(chat, now + ttlMs);
  while (activeUntil.size > MAX_ENTRIES) {
    const oldest = activeUntil.keys().next();
    if (oldest.done) break;
    activeUntil.delete(oldest.value);
  }
}

/** 清除（回傳之前是否有啟動中紀錄，含已逾時）。 */
export function clearAiMode(chat: string): boolean {
  return activeUntil.delete(chat);
}

/**
 * 到期且尚未清除時回傳 true 並清除（供「已退出」一次性通知用）。
 * 從未啟動過回傳 false。
 */
export function consumeExpiredAiMode(chat: string, now = Date.now()): boolean {
  const until = activeUntil.get(chat);
  if (until === undefined) return false;
  if (until <= now) {
    activeUntil.delete(chat);
    return true;
  }
  return false;
}

/**
 * 該對話是否為群組。
 * LINE 看 mid 首碼（C=群組、R=多人聊天室）；Telegram 看負號；
 * WhatsApp 個人版看 @g.us；分不出來的平台一律視為群組（fail-closed，
 * 需把 groupMode 打開才放行；呼叫端應記 log 方便除錯）。
 */
export function isGroupChat(platform: string, chat: string): boolean {
  const c = (chat || "").trim();
  if (!c) return false;
  switch (String(platform || "").toLowerCase()) {
    case "line":
      return /^[CR]/i.test(c);
    case "telegram":
      return c.startsWith("-");
    case "whatsapp":
      return c.toLowerCase().includes("@g.us");
    default:
      return true;
  }
}

/** 啟動／關閉語句（正規化後比對：小寫＋去空白）。 */
export type AiModeCommand = "start" | "stop";
const START_STEMS = ["啟動ai", "進入ai", "開始ai", "打開ai", "開啟ai", "aimode", "ai模式"];
const STOP_STEMS = ["關閉ai", "結束ai", "退出ai", "離開ai", "停止ai", "關閉對話", "結束對話", "退出對話", "aimode關", "ai模式關"];

function normalizeCommandText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, "");
}

/** 回傳 start／stop，否則 null（前綴剝掉後的 rest 或無前綴全文皆可傳入）。 */
export function detectAiModeCommand(text: string): AiModeCommand | null {
  const n = normalizeCommandText(text);
  if (!n) return null;
  // 關閉優先：「aimode關」同時是「aimode」的前綴，啟動先判會誤判。
  if (STOP_STEMS.some((p) => n.startsWith(p))) return "stop";
  if (START_STEMS.some((p) => n.startsWith(p))) return "start";
  return null;
}
