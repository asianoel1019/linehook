import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";

const TASK = "daily";
const MAX_ITEMS = 30;

export interface CountdownItem {
  id: number;
  /** YYYY-MM-DD；yearly 為 MM-DD。 */
  date: string;
  label: string;
  /** 每年重複（週年）。 */
  yearly: boolean;
  /** 提前 N 天提醒。 */
  aheadDays: number;
  by: string;
  createdAt: number;
}

interface CountdownState {
  items: CountdownItem[];
  seq: number;
}

/** 解析「2026-12-31 跨年」「每年 5/20 交往」「6/6 端午 提前3天」。 */
export function parseItem(raw: string, now = nowInTz()): CountdownItem | null {
  const text = raw.trim();
  if (!text) return null;
  const yearly = /每年|週年|紀念日(?!\s*$)/.test(text);
  const aheadM = /(?:提前|還有)\s*(\d{1,2})\s*天/.exec(text);
  const aheadDays = aheadM ? Math.min(Math.max(Number(aheadM[1]), 0), 30) : 0;

  const ymd = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  const md = /(?:^|\s)(\d{1,2})[-/](\d{1,2})(?:\s|$)/.exec(text);
  let date = "";
  let isYearly = yearly;
  if (ymd) {
    const y = Number(ymd[1]);
    if (y < now.getFullYear()) isYearly = true; // 過去年份 → 視為週年紀念
    date = isYearly
      ? `${Number(ymd[2]).toString().padStart(2, "0")}-${Number(ymd[3]).toString().padStart(2, "0")}`
      : `${y}-${Number(ymd[2]).toString().padStart(2, "0")}-${Number(ymd[3]).toString().padStart(2, "0")}`;
  } else if (md) {
    isYearly = true;
    date = `${Number(md[1]).toString().padStart(2, "0")}-${Number(md[2]).toString().padStart(2, "0")}`;
  } else {
    return null;
  }
  const [mo, d] = isYearly ? date.split("-") : date.slice(5).split("-");
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;

  const label = text
    .replace(/(?:^|\s)(?:每年|週年|紀念日)\s*/, " ")
    .replace(ymd?.[0] ?? "", " ")
    .replace(md?.[0] ?? "", " ")
    .replace(/(?:提前|還有)\s*\d{1,2}\s*天/g, " ")
    .replace(/的/g, " ")
    .trim();
  if (!label) return null;

  return {
    id: 0,
    date,
    label,
    yearly: isYearly,
    aheadDays,
    by: "",
    createdAt: 0,
  };
}

function pad(n: number): string {
  return ("0" + n).slice(-2);
}

function isoOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const from = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const to = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export interface Upcoming {
  /** 下一個發生日（YYYY-MM-DD；yearly 為今年或明年）。 */
  nextDate: string;
  days: number;
  /** 第幾週年（yearly 用；從第一次開始算）。 */
  anniversary?: number;
}

/** 計算下一個發生日與倒數天數。 */
export function upcomingOf(item: CountdownItem, today: string): Upcoming {
  if (!item.yearly) {
    return { nextDate: item.date, days: daysBetween(today, item.date) };
  }
  const [mo, d] = item.date.split("-");
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}-${mo}-${d}`;
  const next = daysBetween(today, thisYear) >= 0 ? thisYear : `${year + 1}-${mo}-${d}`;
  const firstYear = item.createdAt ? new Date(item.createdAt).getFullYear() : year;
  const years = Number(next.slice(0, 4)) - firstYear;
  return { nextDate: next, days: daysBetween(today, next), anniversary: Math.max(years, 0) };
}

/** 單行顯示（清單用）。 */
export function renderLine(index: number, item: CountdownItem, today: string): string {
  const u = upcomingOf(item, today);
  const dateLabel = item.yearly
    ? `每年 ${Number(item.date.slice(0, 2))}/${Number(item.date.slice(3))}`
    : item.date.replaceAll("-", "/");
  if (u.days === 0) {
    const ann = item.yearly && u.anniversary && u.anniversary > 0 ? ` 第 ${u.anniversary} 週年` : "";
    return `${index}. 🎉 ${item.label}${ann}（就是今天）`;
  }
  return `${index}. ${item.label}｜${dateLabel}｜還有 ${u.days} 天`;
}

function readItems(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): CountdownItem[] {
  const st = ctx.taskState(TASK) as Partial<CountdownState> | undefined;
  return Array.isArray(st?.items) ? (st.items as CountdownItem[]) : [];
}

function readSeq(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): number {
  const st = ctx.taskState(TASK) as Partial<CountdownState> | undefined;
  return typeof st?.seq === "number" ? st.seq : 0;
}

const countdownSkill: SkillDefinition = {
  id: "countdown",
  name: "紀念日 / 倒數",
  description: {
    zh: "紀錄紀念日與倒數：每年週年、提前提醒、還有幾天。",
    en: "Track anniversaries and countdowns: yearly repeats, advance notices, days remaining.",
    ja: "記念日とカウントダウン：毎年の周年、事前通知、残り日数。",
  },
  usage: {
    zh: "紀念日 2026-12-31 跨年；紀念日 每年 5/20 交往紀念日；紀念日 清單；紀念日 刪除 1",
    en: "countdown 2026-12-31 New Year; countdown yearly 5/20 anniversary; countdown list; countdown delete 1",
    ja: "記念日 2026-12-31 年越し; 記念日 毎年 5/20 記念日; 記念日 一覧; 記念日 削除 1",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "紀念日",
  triggerAliases: ["紀念", "週年", "倒數計時", "countdown", "紀念日清單"],
  fields: [],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "紀念日", ok: true, detail: "就緒（資料隨對話保存）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    // 保留「每年／週年」等關鍵字給 parseItem 判斷，只移除禮貌用語。
    const raw = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();
    const items = readItems(ctx);
    const today = isoOf(nowInTz());

    if (/^(清單|列表|list)$/i.test(raw) || raw === "") {
      if (items.length === 0) {
        await ctx.reply("目前沒有紀念日。\n用法：阿寶請幫忙 紀念日 2026-12-31 跨年（每年：紀念日 每年 5/20 交往）");
        return;
      }
      const sorted = [...items].sort((a, b) => upcomingOf(a, today).days - upcomingOf(b, today).days);
      const lines = sorted.map((it, i) => renderLine(i + 1, it, today));
      await ctx.reply(`紀念日／倒數（${items.length}）：\n${lines.join("\n")}`);
      return;
    }

    // 刪除
    const del = /^(刪除|刪掉|delete|del|移除)\s*(\d*)$/i.exec(raw);
    if (del) {
      if (items.length === 0) {
        await ctx.reply("目前沒有紀念日。");
        return;
      }
      const sorted = [...items].sort((a, b) => upcomingOf(a, today).days - upcomingOf(b, today).days);
      const idx = del[2] ? Number(del[2]) - 1 : sorted.length - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= sorted.length) {
        await ctx.reply(`找不到第 ${del[2]} 個，請用「紀念日 清單」查看編號。`);
        return;
      }
      const removed = sorted[idx];
      const kept = items.filter((it) => it !== removed);
      ctx.watch({ task: TASK, everyMinutes: 1440, state: { items: kept, seq: readSeq(ctx) } });
      await ctx.reply(`已刪除：${removed.label}`);
      return;
    }

    // 新增
    if (items.length >= MAX_ITEMS) {
      await ctx.reply(`紀念日已達上限（${MAX_ITEMS} 個），請先刪除舊的。`);
      return;
    }
    const parsed = parseItem(raw);
    if (!parsed) {
      await ctx.reply(
        "用法：\n紀念日 2026-12-31 跨年\n紀念日 每年 5/20 交往（自動算週年）\n紀念日 6/6 端午 提前3天\n紀念日 清單｜紀念日 刪除 1",
      );
      return;
    }
    let seq = readSeq(ctx);
    seq += 1;
    const item: CountdownItem = { ...parsed, id: seq, by: ctx.fromName, createdAt: Date.now() };
    const updated = [...items, item];
    ctx.watch({ task: TASK, everyMinutes: 1440, state: { items: updated, seq } });

    const u = upcomingOf(item, today);
    const when = u.days === 0 ? "就是今天" : `還有 ${u.days} 天`;
    const yearlyNote = item.yearly ? "（每年週年提醒）" : "";
    logger.info("紀念日新增", { chat: ctx.chat, label: item.label, date: item.date });
    await ctx.reply(
      `已紀錄：${item.label}｜${item.yearly ? `每年 ${item.date.replace("-", "/")}` : item.date}${yearlyNote}\n${when}`,
    );
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const items = (ctx.state?.items ?? []) as CountdownItem[];
    if (items.length === 0) return;
    const today = isoOf(nowInTz());
    for (const item of items) {
      const u = upcomingOf(item, today);
      if (u.days === 0) {
        const ann = item.yearly && u.anniversary && u.anniversary > 0 ? `第 ${u.anniversary} 週年！` : "";
        await ctx.reply(`🎉 ${item.label}${ann ? ` ${ann}` : "！"}（今天）`);
      } else if (item.aheadDays > 0 && u.days === item.aheadDays) {
        await ctx.reply(
          `⏳ 倒數 ${u.days} 天：${item.label}（${item.yearly ? `每年 ${item.date.replace("-", "/")}` : item.date}）`,
        );
      }
    }
  },
};

export default countdownSkill;
