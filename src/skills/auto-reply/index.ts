import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition } from "../types.js";

interface AutoReplyRule {
  keyword: string;
  match?: "exact" | "contains" | "regex";
  text?: string;
  image?: string;
  filePath?: string;
  filename?: string;
  enabled?: boolean;
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
    { key: "cooldownSec", label: "回覆冷卻（秒）", hint: "同一個聊天於此時間內只回覆一次，例如 10" },
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
    { key: "text", label: { zh: "回覆文字", en: "Reply text", ja: "返信テキスト" }, hint: "可用 {{name}}（對方名稱）、{{keyword}}、{{text}}" },
    { key: "image", label: "回覆圖片", type: "file", hint: "上傳圖片或填 URL / 路徑" },
    { key: "filePath", label: "回覆檔案", type: "file", hint: "上傳檔案或填伺服器路徑" },
    { key: "filename", label: "顯示檔名", hint: "選填" },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const text = ctx.text;
    if (!text) return;

    const rules = parseRules(ctx.config.rules || "");
    const active = rules.filter((rule) => rule.enabled !== false && rule.keyword);
    if (active.length === 0) return;

    const rule = active.find((candidate) => {
      const match = candidate.match ?? "exact";
      const keywords = candidate.keyword
        .split("|")
        .map((k) => k.trim())
        .filter(Boolean);
      return keywords.some((k) => matchKeyword(match, k, text));
    });
    if (!rule) return;

    const cooldownSec = Number(ctx.config.cooldownSec ?? "10");
    const now = Date.now();
    const last = cooldown.get(ctx.chat) ?? 0;
    if (Number.isFinite(cooldownSec) && cooldownSec > 0 && now - last < cooldownSec * 1000) {
      logger.info("自動回覆冷卻中，略過", { chat: ctx.chat });
      return;
    }
    cooldown.set(ctx.chat, now);

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
