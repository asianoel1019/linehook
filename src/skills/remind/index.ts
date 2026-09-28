import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import type { SkillContext, SkillDefinition } from "../types.js";

function pad(n: number): string {
  return ("0" + n).slice(-2);
}

function formatTime(date: Date): string {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 解析提醒時間，回傳 runAt(ms) 與剩餘時間文字。
 * 支援：
 *  - 30 分鐘後 / 2小時後 / 90秒後
 *  - 明天 09:00 / 今天 18:30 / 2026-01-01 09:00 / 9:30
 */
function parseWhen(args: string): { runAt: number; when: Date } | { error: string } {
  const now = nowInTz();

  // 相對時間：N 秒/分鐘/小時後
  const rel = args.match(/(\d+(?:\.\d+)?)\s*(秒|分鐘|分|小時|時|天)\s*(?:後|之後)?/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "秒" ? n * 1000 : unit.includes("分") ? n * 60_000 : unit.includes("小時") || unit === "時" ? n * 3600_000 : n * 86400_000;
    if (ms > 0) {
      const when = new Date(now.getTime() + ms);
      return { runAt: when.getTime(), when };
    }
  }

  // 絕對時間：今天/明天/後天 + HH:mm，或 MM-DD / YYYY-MM-DD + HH:mm
  const timeMatch = args.match(/(\d{1,2})[:：](\d{2})/);
  if (timeMatch) {
    const hh = Number(timeMatch[1]);
    const mm = Number(timeMatch[2]);
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (/明天|明日/.test(args)) when.setDate(when.getDate() + 1);
    else if (/後天/.test(args)) when.setDate(when.getDate() + 2);

    const ymd = args.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    const md = args.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (ymd) when.setFullYear(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    else if (md) when.setMonth(Number(md[1]) - 1, Number(md[2]));

    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1); // 已過則順延一天
    return { runAt: when.getTime(), when };
  }

  return { error: "無法解析時間" };
}

const remindSkill: SkillDefinition = {
  id: "remind",
  name: "提醒 / 倒數",
  description: {
    zh: "設定定時提醒。",
    en: "Set a timed reminder.",
    ja: "タイマーリマインダーを設定します。",
  },
  usage: {
    zh: "提醒 30分鐘後 喝水",
    en: "remind in 30 min drink water",
    ja: "リマインド 30分後 水を飲む",
  },
  category: {
    zh: "工具",
    en: "Tools",
    ja: "ツール",
  },
  defaultTrigger: "提醒",
  triggerAliases: ["倒數", "提醒我", "定時"],
  fields: [],
  async run(ctx: SkillContext): Promise<void> {
    const parsed = parseWhen(ctx.args);
    if ("error" in parsed) {
      await ctx.reply("用法：提醒 30分鐘後 喝水，或 提醒 明天 09:00 開會");
      return;
    }

    // 取出提醒內容：移除時間片段後剩下的文字
    const content = ctx.args
      .replace(/(\d+(?:\.\d+)?)\s*(秒|分鐘|分|小時|時|天)\s*(?:後|之後)?/g, " ")
      .replace(/今天|明天|明日|後天/g, " ")
      .replace(/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/g, " ")
      .replace(/\d{1,2}[\/\-]\d{1,2}/g, " ")
      .replace(/\d{1,2}[:：]\d{2}/g, " ")
      .replace(/^(提醒|倒數|提醒我|定時)\s*/g, " ")
      .trim();
    const text = content || "時間到了！";

    const jobId = ctx.schedule(text, parsed.runAt);
    logger.info("已建立提醒", { chat: ctx.chat, runAt: parsed.when.toISOString(), jobId });
    await ctx.reply(`好的，將於 ${formatTime(parsed.when)} 提醒你：「${text}」`);
  },
};

export default remindSkill;
