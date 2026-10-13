import { logger } from "@lw/logger";
import { nowInTz } from "@lw/time";
import type { SkillContext, SkillDefinition } from "@lw/skills/types";

export interface AutoReplyRule {
  keyword: string;
  match?: "exact" | "contains" | "regex";
  text?: string;
  image?: string;
  filePath?: string;
  filename?: string;
  enabled?: boolean;
  /** 只在這個時段回覆（HH:mm–HH:mm，可跨夜，例如 22:00–06:00）；留空 = 全天。 */
  timeFrom?: string;
  timeTo?: string;
  /** 只在这些星期回覆，1=週一…7=週日（例如 1,2,3,4,5）；留空 = 每天。 */
  weekdays?: string;
  /** 這條規則的冷卻秒數（覆蓋全域 cooldownSec）。 */
  cooldownSec?: number;
}

/** 冷卻 key：每「對話＋寄件者」分開算——群組裡一人觸發不再靜音全團。 */
function cooldownKey(chat: string, fromMid: string): string {
  return fromMid ? `${chat}:${fromMid}` : chat;
}

const cooldown = new Map<string, number>();

function renderTemplate(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

function matchKeyword(match: "exact" | "contains" | "regex", keyword: string, text: string): boolean {
  const key = keyword.trim();
  if (!key) return false;
  if (match === "contains") return text.includes(key);
  if (match === "regex") {
    try {
      return new RegExp(key, "i").test(text);
    } catch {
      return false;
    }
  }
  return key === text;
}

function parseRules(raw: string): AutoReplyRule[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as AutoReplyRule[];
  } catch {
    // ignore
  }
  return [];
}

/** 從 rules JSON 取出啟用中（有關鍵字）的規則；不含時段/星期過濾。 */
export function activeRules(config: Record<string, string>): AutoReplyRule[] {
  return parseRules(config.rules || "").filter((rule) => rule.enabled !== false && rule.keyword);
}

/** 「HH:mm」→ 當天分鐘數；無法解析回 null。 */
export function parseHm(value: string | undefined): number | null {
  const m = /^\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*$/.exec(value ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 星期清單 → Set（1=週一…7=週日；0 或 7 都算週日）；空/壞 → null（不過濾）。 */
export function parseWeekdays(value: string | undefined): Set<number> | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const out = new Set<number>();
  for (const part of raw.split(/[,，、\s]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 7) return null;
    out.add(n === 0 ? 7 : n);
  }
  return out.size > 0 ? out : null;
}

/**
 * 規則的時段/星期是否放行（純函式，測試與模擬器共用）。
 * 時段可跨夜（from > to 表示跨午夜）；weekdays 為 JS 的 0=週日…6=週六。
 */
export function ruleScheduleOk(rule: AutoReplyRule, now: Date): boolean {
  const from = parseHm(rule.timeFrom);
  const to = parseHm(rule.timeTo);
  if (from !== null && to !== null && from !== to) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const inWindow = from < to ? cur >= from && cur < to : cur >= from || cur < to;
    if (!inWindow) return false;
  }
  const days = parseWeekdays(rule.weekdays);
  if (days && !days.has(now.getDay() === 0 ? 7 : now.getDay())) return false;
  return true;
}

/** 此刻真正生效的規則（啟用＋關鍵字＋時段/星期）。 */
export function rulesForNow(config: Record<string, string>, now = nowInTz()): AutoReplyRule[] {
  return activeRules(config).filter((rule) => ruleScheduleOk(rule, now));
}

/** 找出第一條命中的規則（不含冷卻判斷；順序即優先序）。 */
export function matchAutoReplyRule(rules: AutoReplyRule[], text: string): AutoReplyRule | undefined {
  return rules.find((candidate) => {
    const match = candidate.match ?? "exact";
    const keywords = candidate.keyword
      .split("|")
      .map((k) => k.trim())
      .filter(Boolean);
    return keywords.some((k) => matchKeyword(match, k, text));
  });
}

/** 規則的冷卻秒數：規則覆寫 > 全域；非數字回 0（關閉冷卻）。 */
export function cooldownSecOf(rule: AutoReplyRule, globalSec: unknown): number {
  const n = Number(rule.cooldownSec ?? globalSec ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 該對話目前是否仍在回覆冷卻中（唯讀；供規則模擬器）。 */
export function isCooling(key: string, cooldownSec: number, now = Date.now()): boolean {
  const last = cooldown.get(key) ?? 0;
  if (!Number.isFinite(cooldownSec) || cooldownSec <= 0) return false;
  return now - last < cooldownSec * 1000;
}

/** 一條規則被排除的人類可讀原因（時段/星期）。 */
export function scheduleBlockReason(rule: AutoReplyRule, now: Date): string {
  const from = parseHm(rule.timeFrom);
  const to = parseHm(rule.timeTo);
  if (from !== null && to !== null && from !== to) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const inWindow = from < to ? cur >= from && cur < to : cur >= from || cur < to;
    if (!inWindow) return `不在時段 ${rule.timeFrom}–${rule.timeTo}`;
  }
  const days = parseWeekdays(rule.weekdays);
  if (days && !days.has(now.getDay() === 0 ? 7 : now.getDay())) return `今天不是設定的星期（${rule.weekdays}）`;
  return "時段/星期不符";
}

/** 自動回覆的最終判定：run 與規則模擬器共用（單一事實來源）。 */
export type AutoReplyDecision =
  | { outcome: "miss"; reason: string }
  | { outcome: "blocked"; reason: string; rule: AutoReplyRule }
  | { outcome: "hit"; rule: AutoReplyRule };

/**
 * 依設定、訊息、對話與寄件者，判斷自動回覆的結果。
 * 順序：關鍵字 → 時段/星期 → 冷卻（每來源）。
 */
export function resolveAutoReply(
  config: Record<string, string>,
  text: string,
  chat: string,
  fromMid: string,
  now: Date,
): AutoReplyDecision {
  const active = activeRules(config);
  const rule = matchAutoReplyRule(active, text);
  if (!rule) return { outcome: "miss", reason: `沒有符合的關鍵字規則（${active.length} 條啟用中）` };

  if (!ruleScheduleOk(rule, now)) {
    return { outcome: "blocked", reason: `命中規則「${rule.keyword}」但${scheduleBlockReason(rule, now)}`, rule };
  }

  const sec = cooldownSecOf(rule, config.cooldownSec);
  const key = fromMid ? `${chat}:${fromMid}` : chat;
  if (isCooling(key, sec, now.getTime())) {
    return { outcome: "blocked", reason: `命中規則「${rule.keyword}」但冷卻中（${sec} 秒內已回覆過）`, rule };
  }
  return { outcome: "hit", rule };
}

const autoReplySkill: SkillDefinition = {
  id: "auto-reply",
  name: "關鍵字自動回覆",
  description: {
    zh: "收到訊息符合關鍵字時自動回覆（每則訊息都會檢查）。",
    en: "Auto-reply when a message matches a keyword (checks every message).",
    ja: "キーワード一致時に自動返信（毎メッセージ確認）。",
  },
  usage: {
    zh: "收到訊息符合關鍵字時自動回覆（每則訊息都會檢查）。",
    en: "Auto-reply when a message matches a keyword (checks every message).",
    ja: "キーワード一致時に自動返信（毎メッセージ確認）。",
  },
  category: {
    zh: "自動化",
    en: "Automation",
    ja: "自動化",
  },
  defaultTrigger: "",
  triggerMode: "any",
  fields: [
    {
      key: "cooldownSec",
      label: "回覆冷卻（秒）",
      hint: "同一位使用者在此時間內只回一次；群組裡不同人互不影響。例如 10",
    },
  ],
  ruleKey: "rules",
  ruleFields: [
    { key: "keyword", label: "關鍵字", hint: "可用 | 分隔多組，例如 報價|價目" },
    {
      key: "match",
      label: { zh: "比對方式", en: "Match type", ja: "一致方法" },
      type: "select",
      options: [
        { value: "contains", label: "包含" },
        { value: "exact", label: "完全相符" },
        { value: "regex", label: "正則" },
      ],
    },
    {
      key: "text",
      label: { zh: "回覆文字", en: "Reply text", ja: "返信テキスト" },
      hint: "可用 {{name}}（對方名稱）、{{keyword}}、{{text}}",
    },
    { key: "timeFrom", label: { zh: "起始時間", en: "From", ja: "開始時刻" }, hint: "HH:mm，例如 09:00；留空 = 全天" },
    {
      key: "timeTo",
      label: { zh: "結束時間", en: "To", ja: "終了時刻" },
      hint: "HH:mm；早於起始時間代表跨夜（22:00–06:00）",
    },
    {
      key: "weekdays",
      label: { zh: "星期", en: "Weekdays", ja: "曜日" },
      hint: "1=週一…7=週日，逗號分隔（例如 1,2,3,4,5）；留空 = 每天",
    },
    {
      key: "cooldownSec",
      label: { zh: "此規則冷卻（秒）", en: "Cooldown (s)", ja: "クールダウン（秒）" },
      hint: "覆蓋上方全域冷卻；0 = 這條不冷卻",
    },
    { key: "image", label: "回覆圖片", type: "file", hint: "上傳圖片或填 URL / 路徑" },
    { key: "filePath", label: "回覆檔案", type: "file", hint: "上傳檔案或填伺服器路徑" },
    { key: "filename", label: "顯示檔名", hint: "選填" },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const text = ctx.text;
    if (!text) return;

    const decision = resolveAutoReply(ctx.config, text, ctx.chat, ctx.fromMid, nowInTz());
    if (decision.outcome === "miss") return;
    if (decision.outcome === "blocked") {
      logger.info("自動回覆略過", { chat: ctx.chat, from: ctx.fromMid, reason: decision.reason });
      return;
    }

    const rule = decision.rule;
    const key = cooldownKey(ctx.chat, ctx.fromMid);
    cooldown.set(key, Date.now());

    logger.info("觸發自動回覆", { keyword: rule.keyword, match: rule.match ?? "exact", to: ctx.chat });

    const vars: Record<string, string> = {
      name: ctx.fromName,
      mid: ctx.chat,
      keyword: rule.keyword,
      text,
    };

    if (rule.text) await ctx.reply(renderTemplate(rule.text, vars));
    if (rule.image) await ctx.sendImage(rule.image, rule.filename);
    if (rule.filePath) await ctx.sendFile(rule.filePath, rule.filename);
  },
};

export default autoReplySkill;
