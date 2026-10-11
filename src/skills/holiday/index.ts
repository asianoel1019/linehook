import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import { nowInTz } from "../../time.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";

const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";
/** 台灣國定假日 iCal（Google 公開行事曆，免 key、機器可讀）。 */
const ICS_URL =
  "https://calendar.google.com/calendar/ical/zh.taiwan%23holiday%40group.v.calendar.google.com/public/basic.ics";
const TASK = "daily";

export interface IcsEvent {
  /** 起日（含）YYYY-MM-DD（當地時區）。 */
  start: string;
  /** 訖日（不含）YYYY-MM-DD；全天事件 DTEND。 */
  end: string;
  summary: string;
}

/** 展開 RFC5545 續行（以空格/TAB 開頭視為上一行的延續）。 */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length > 0) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

function decodeIcsValue(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function parseDateValue(value: string): { date: string; end: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(value.trim());
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) {
    // VALUE=DATE：DTEND 為隔天，呼叫端自行 +1
    return { date: ymd, end: addDays(ymd, 1) };
  }
  return { date: ymd, end: ymd };
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** 解析 iCal 文字為事件清單（全天與帶時間事件皆收；無 DTSTART 的事件略過）。 */
export function parseIcs(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: { start?: string; end?: string; summary?: string } | null = null;
  const flush = (): void => {
    if (cur?.start) {
      out.push({ start: cur.start, end: cur.end ?? addDays(cur.start, 1), summary: cur.summary ?? "假日" });
    }
    cur = null;
  };
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      flush();
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const namePart = line.slice(0, idx).toUpperCase();
    const value = line.slice(idx + 1);
    const prop = namePart.split(";")[0];
    if (prop === "DTSTART") {
      const parsed = parseDateValue(value);
      if (parsed) {
        cur.start = parsed.date;
        if (!cur.end) cur.end = parsed.end;
      }
    } else if (prop === "DTEND") {
      const parsed = parseDateValue(value);
      if (parsed) cur.end = parsed.date;
    } else if (prop === "SUMMARY") {
      cur.summary = decodeIcsValue(value);
    }
  }
  flush();
  return out;
}

/** 把事件展開成「YYYY-MM-DD → 假日名」映射（多日事件涵蓋每一天）。 */
export function buildHolidayMap(events: IcsEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ev of events) {
    const from = new Date(`${ev.start}T00:00:00Z`).getTime();
    const to = new Date(`${ev.end}T00:00:00Z`).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      map.set(ev.start, ev.summary);
      continue;
    }
    for (let t = from; t < to; t += 86_400_000) {
      const d = new Date(t);
      map.set(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
        ev.summary,
      );
    }
  }
  return map;
}

/** 解析使用者設定的補班日清單（"2026-02-28, 6/6" → Set<YYYY-MM-DD>）。 */
export function parseMakeupDays(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (raw ?? "").split(/[,，、\s]+/)) {
    const t = token.trim();
    if (!t) continue;
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
    const year = nowInTz().getFullYear();
    if (ymd) out.add(`${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`);
    else if (md) out.add(`${year}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`);
  }
  return out;
}

export interface DayStatus {
  off: boolean;
  reason: "weekend" | "holiday" | "workday" | "makeup";
  name: string;
}

/** 判斷某日是否放假（補班日 > 國定假日 > 週末 > 平日）。 */
export function dayStatus(ymd: string, holidays: Map<string, string>, makeup: Set<string>): DayStatus {
  if (makeup.has(ymd)) return { off: false, reason: "makeup", name: "補行上班" };
  const holiday = holidays.get(ymd);
  if (holiday) return { off: true, reason: "holiday", name: holiday };
  const [y, m, d] = ymd.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return { off: true, reason: "weekend", name: "週末" };
  return { off: false, reason: "workday", name: "" };
}

function isoOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export interface OffSpan {
  /** 連假起日（含）。 */
  from: string;
  /** 連假訖日（含）。 */
  to: string;
  days: number;
  names: string[];
}

/** 從 fromYmd 起找下一個「不放假→放假」的連假區間（長度 >=1）。 */
export function nextOffSpan(fromYmd: string, holidays: Map<string, string>, makeup: Set<string>): OffSpan | null {
  let cursor = fromYmd;
  for (let i = 0; i < 400; i++) {
    if (dayStatus(cursor, holidays, makeup).off) break;
    cursor = addDays(cursor, 1);
  }
  const names: string[] = [];
  const from = cursor;
  let days = 0;
  for (let i = 0; i < 60; i++) {
    const st = dayStatus(cursor, holidays, makeup);
    if (!st.off) break;
    if (st.name && !names.includes(st.name)) names.push(st.name);
    cursor = addDays(cursor, 1);
    days++;
  }
  if (days === 0) return null;
  return { from, to: addDays(cursor, -1), days, names };
}

async function loadHolidays(ttlMs: number): Promise<Map<string, string>> {
  const hit = readCache<Record<string, string>>("holiday-tw", ttlMs);
  if (hit && typeof hit === "object") return new Map(Object.entries(hit));
  const text = await netFetchText(
    ICS_URL,
    { headers: { "User-Agent": UA } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
  const map = buildHolidayMap(parseIcs(text));
  if (map.size === 0) throw new Error("假日行事曆解析不到資料");
  writeCache("holiday-tw", Object.fromEntries(map));
  return map;
}

/**
 * 查詢指定日期的放假狀態（含抓取假日表與快取）。
 * 供 morning、remind 等兄弟技能共用；抓取失敗時拋錯，呼叫端自行降級。
 */
export async function loadDayStatus(ymd: string, makeupRaw: string | undefined): Promise<DayStatus> {
  const holidays = await loadHolidays(24 * 60 * 60 * 1000);
  return dayStatus(ymd, holidays, parseMakeupDays(makeupRaw));
}

function notifyAt(config: Record<string, string>): string {
  const m = /^\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*$/.exec(config.notifyAt ?? "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "07:00";
}

function fmtPretty(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** 未來 N 天內的國定假日（排除週末，用於「今年/剩餘」）。 */
function remainingHolidays(
  fromYmd: string,
  holidays: Map<string, string>,
  makeup: Set<string>,
  limit: number,
): Array<{ date: string; name: string }> {
  const out: Array<{ date: string; name: string }> = [];
  let cursor = fromYmd;
  const year = Number(fromYmd.slice(0, 4));
  const until = `${year}-12-31`;
  for (let i = 0; i < 366 && cursor <= until && out.length < limit; i++) {
    const name = holidays.get(cursor);
    if (name && !makeup.has(cursor)) out.push({ date: cursor, name });
    cursor = addDays(cursor, 1);
  }
  return out;
}

const holidaySkill: SkillDefinition = {
  id: "holiday",
  name: "放假 / 工作日曆",
  description: {
    zh: "查詢今天/明天是否放假、下一個連假、剩餘假日；可每日推播。",
    en: "Check whether a day is off, the next long weekend, and remaining holidays; daily push supported.",
    ja: "今日・明日が休みか、次の連休、残りの祝日を確認。毎日通知にも対応。",
  },
  usage: {
    zh: "放假；放假 明天；放假 下一個；放假 今年；放假 訂閱 07:00；放假 補班 2026-02-28",
    en: "holiday; holiday tomorrow; holiday next; holiday this year; holiday subscribe 07:00; holiday makeup 2026-02-28",
    ja: "休暇；休暇 明日；休暇 次；休暇 今年；休暇 購読 07:00；休暇 振替出勤 2026-02-28",
  },
  category: { zh: "生活資訊", en: "Life", ja: "生活" },
  defaultTrigger: "放假",
  triggerAliases: ["假日", "上班嗎", "補班", "工作日", "holiday"],
  fields: [
    {
      key: "makeupDays",
      label: { zh: "補班日", en: "Make-up workdays", ja: "振替出勤日" },
      type: "textarea",
      hint: "放假卻要上班的補班日，逗號分隔（例：2026-02-28, 2026-06-06）；留空表示沒有補班日",
    },
    {
      key: "cacheTtl",
      label: { zh: "假日資料快取（小時）", en: "Holiday cache (hours)", ja: "祝日キャッシュ（時間）" },
      hint: "預設 24 小時",
    },
    {
      key: "notifyAt",
      label: { zh: "每日推播時間", en: "Daily push time", ja: "毎日の通知時刻" },
      hint: "預設 07:00（HH:mm）",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await loadHolidays(60 * 60 * 1000);
      return [{ name: "台灣假日行事曆", ok: true, detail: "Google 公開 iCal" }];
    } catch (error) {
      return [{ name: "台灣假日行事曆", ok: false, detail: error instanceof Error ? error.message : String(error) }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const args = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();

    // 訂閱 / 取消 / 清單
    if (/^(訂閱|subscribe)/.test(args)) {
      const m = /(?:訂閱|subscribe)\s*([0-2]?\d[:：][0-5]\d)/.exec(args);
      const time = m ? m[1].replace("：", ":").padStart(5, "0") : notifyAt(ctx.config);
      ctx.watch({ task: TASK, at: time, state: {} });
      await ctx.reply(`已訂閱每日放假推播，每天 ${time} 通知你今天是否上班。`);
      return;
    }
    if (/^(取消|退訂|停止)/.test(args)) {
      const ok = ctx.unwatch(TASK);
      await ctx.reply(ok ? "已停止每日放假推播。" : "目前沒有每日推播訂閱。");
      return;
    }
    if (/^(清單|列表)/.test(args)) {
      const watches = ctx.watches();
      if (watches.length === 0) {
        await ctx.reply("目前沒有推播訂閱。用法：放假 訂閱 07:00");
        return;
      }
      const lines = watches.map((w) => `・每日 ${notifyAt(ctx.config)} 推播｜下次 ${fmtPretty(w.runAt.slice(0, 10))}`);
      await ctx.reply(`放假推播（${watches.length}）：\n${lines.join("\n")}`);
      return;
    }
    const makeupSet = /^(補班|makeup)\s*(.*)$/i.exec(args);
    if (makeupSet) {
      if (!makeupSet[2].trim()) {
        await ctx.reply("用法：放假 補班 2026-02-28, 2026-06-06（在技能設定可直接修改「補班日」欄位）");
        return;
      }
      const days = [...parseMakeupDays(makeupSet[2])].sort();
      await ctx.reply(
        `臨時補班日解析結果（未儲存，請到技能設定「補班日」欄位保存）：\n${days.map(fmtPretty).join("、") || "（解析不到）"}`,
      );
      return;
    }

    // 查詢
    const now = nowInTz();
    let holidays: Map<string, string>;
    try {
      holidays = await loadHolidays(parseTtl(ctx.config.cacheTtl, 1440));
    } catch (error) {
      logger.warn("假日資料載入失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("假日行事曆暫時無法連線，請稍後再試。");
      return;
    }
    const makeup = parseMakeupDays(ctx.config.makeupDays);
    const today = isoOf(now);

    // 下一個連假 / 剩餘假日
    if (/下一個|下個|連假/.test(args)) {
      const span = nextOffSpan(today, holidays, makeup);
      if (!span) {
        await ctx.reply("查無下一個假日。");
        return;
      }
      const label = span.days >= 3 ? "連假" : "假日";
      const names = span.names.length > 0 ? `（${span.names.join("、")}）` : "";
      await ctx.reply(
        `下一個${label}：${fmtPretty(span.from)}–${fmtPretty(span.to)}，共 ${span.days} 天${names}\n距今 ${daysFrom(today, span.from)} 天。`,
      );
      return;
    }

    if (/今年|剩餘/.test(args)) {
      const list = remainingHolidays(today, holidays, makeup, 15);
      if (list.length === 0) {
        await ctx.reply("今年剩下的國定假日都過完了。");
        return;
      }
      const lines = list.map((h) => `・${fmtPretty(h.date)} ${h.name}`);
      await ctx.reply(`今年剩餘國定假日（${list.length}）：\n${lines.join("\n")}`);
      return;
    }

    // 目標日：預設今天
    let target = today;
    const dateArg = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(args);
    const mdArg = /(\d{1,2})[-/](\d{1,2})/.exec(args);
    if (dateArg) {
      target = `${dateArg[1]}-${Number(dateArg[2]).toString().padStart(2, "0")}-${Number(dateArg[3]).toString().padStart(2, "0")}`;
    } else if (/(明天|明日)/.test(args)) target = addDays(today, 1);
    else if (/後天/.test(args)) target = addDays(today, 2);
    else if (/上一個|上個|前一個/.test(args)) {
      target = addDays(today, -1);
      for (let i = 0; i < 14; i++) {
        if (dayStatus(target, holidays, makeup).off) break;
        target = addDays(target, -1);
      }
    } else if (mdArg) {
      target = `${now.getFullYear()}-${Number(mdArg[1]).toString().padStart(2, "0")}-${Number(mdArg[2]).toString().padStart(2, "0")}`;
    }

    const st = dayStatus(target, holidays, makeup);
    const head = target === today ? "今天" : fmtPretty(target);
    if (st.off) {
      const why = st.reason === "weekend" ? "週末" : st.name;
      await ctx.reply(`${head} 放假${why ? `（${why}）` : ""}，不用上班。`);
      return;
    }
    const span = nextOffSpan(today, holidays, makeup);
    const untilSpan = span ? `距離下一個連假還有 ${daysFrom(today, span.from)} 天。` : "";
    await ctx.reply(`${head} 要上班${st.name ? `（${st.name}－補班）` : ""}。${untilSpan}`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const now = nowInTz();
    const today = isoOf(now);
    let holidays: Map<string, string>;
    try {
      holidays = await loadHolidays(24 * 60 * 60 * 1000);
    } catch (error) {
      logger.warn("每日放假推播失敗", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const makeup = parseMakeupDays(ctx.config.makeupDays);
    const st = dayStatus(today, holidays, makeup);
    const tomorrow = addDays(today, 1);
    const st2 = dayStatus(tomorrow, holidays, makeup);
    const lines: string[] = [];
    lines.push(st.off ? `☀️ 今天是 ${st.name || "假日"}，放假！` : `💼 今天要上班。`);
    lines.push(
      st2.off
        ? `明天（${fmtPretty(tomorrow)}）放假${st2.name && st2.reason !== "weekend" ? `（${st2.name}）` : ""}。`
        : `明天（${fmtPretty(tomorrow)}）要上班。`,
    );
    const span = nextOffSpan(today, holidays, makeup);
    if (span) {
      const label = span.days >= 3 ? "連假" : "假日";
      lines.push(
        `下一個${label}：${fmtPretty(span.from)}–${fmtPretty(span.to)}（${span.days} 天，還有 ${daysFrom(today, span.from)} 天）`,
      );
    }
    await ctx.reply(lines.join("\n"));
  },
};

function daysFrom(fromYmd: string, toYmd: string): number {
  const from = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const to = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export default holidaySkill;
