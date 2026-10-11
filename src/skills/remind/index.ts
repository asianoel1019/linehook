import { createHash } from "node:crypto";
import { logger } from "../../logger.js";
import { nowInTz, zonedTimeToMs } from "../../time.js";
import { solarToLunar } from "../lunar/index.js";
import type { SkillContext, SkillDefinition, SkillWatchView, SkillTaskContext } from "../types.js";

function pad(n: number): string {
  return ("0" + n).slice(-2);
}

function formatTime(date: Date): string {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 解析單次提醒時間，回傳 runAt(ms) 與時間。
 * 支援：
 *  - 30 分鐘後 / 2小時後 / 90秒後
 *  - 明天 09:00 / 今天 18:30 / 2026-01-01 09:00 / 9:30
 */
function parseWhen(args: string): { runAt: number; when: Date } | { error: string } {
  const now = nowInTz();
  const nowMs = Date.now();

  // 相對時間：N 秒/分鐘/小時後
  const rel = args.match(/(\d+(?:\.\d+)?)\s*(秒|分鐘|分|小時|時|天)\s*(?:後|之後)?/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms =
      unit === "秒"
        ? n * 1000
        : unit.includes("分")
          ? n * 60_000
          : unit.includes("小時") || unit === "時"
            ? n * 3600_000
            : n * 86400_000;
    if (ms > 0) {
      const runAt = nowMs + ms;
      return { runAt, when: new Date(runAt) };
    }
  }

  // 絕對時間：今天/明天/後天 + HH:mm，或 MM-DD / YYYY-MM-DD + HH:mm（以設定時區解讀）
  const timeMatch = args.match(/(\d{1,2})[:：](\d{2})/);
  if (timeMatch) {
    const hh = Number(timeMatch[1]);
    const mm = Number(timeMatch[2]);
    let y = now.getFullYear();
    let mo = now.getMonth() + 1;
    let d = now.getDate();
    if (/明天|明日/.test(args)) d += 1;
    else if (/後天/.test(args)) d += 2;

    const ymd = args.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    const md = args.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (ymd) {
      y = Number(ymd[1]);
      mo = Number(ymd[2]);
      d = Number(ymd[3]);
    } else if (md) {
      mo = Number(md[1]);
      d = Number(md[2]);
    }

    let runAt = zonedTimeToMs({ year: y, month: mo, day: d, hour: hh, minute: mm });
    if (runAt <= nowMs) runAt = zonedTimeToMs({ year: y, month: mo, day: d + 1, hour: hh, minute: mm }); // 已過則順延一天
    return { runAt, when: new Date(runAt) };
  }

  return { error: "無法解析時間" };
}

/** 週期性排程解析結果。 */
interface Recurring {
  /** 排程描述（回覆用），例如「每天 08:00」。 */
  label: string;
  /** 提醒內容（移除排程關鍵字後的文字）。 */
  content: string;
  watch:
    | { cron: string }
    | { everyMinutes: number }
    | { at: string }
    | { lunar: { month: number; day: number }; at: string };
}

const WEEKDAY_CN: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function timeOf(text: string): { hh: number; mm: number } | null {
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** 移除排程關鍵字，剩下的就是提醒內容。 */
function stripSchedule(text: string, lunar = false): string {
  const base = text
    .replace(/(\d{1,2})\s*[:：]\s*(\d{2})/g, " ")
    .replace(/每天|每日|平日|工作日|週末|假日/g, " ")
    .replace(
      /每週\s*[一二三四五六日天]|每星期\s*[一二三四五六日天]|礼拜\s*[一二三四五六日天]|星期\s*[一二三四五六日天]/g,
      " ",
    )
    .replace(/每月\s*\d{1,2}\s*(號|日)/g, " ")
    .replace(/(?:每隔|每)\s*\d{1,4}\s*(分鐘|小時|分|時)/g, " ")
    .replace(/農曆/g, " ")
    .replace(/\d{1,2}\s*(秒|分鐘|分|小時|時|天)\s*(後|之後)?/g, " ")
    .replace(/^(提醒|倒數|提醒我|定時)\s*/g, " ")
    .replace(/^[，,。！!？?\s]+/g, "")
    .replace(/[，,。！!？?\s]+$/g, "")
    .trim();
  if (!lunar) return base;
  // 農曆 M/D 只在使用者明確輸入農曆時才從內容剝除，避免誤刪一般日期。
  return base
    .replace(/\d{1,2}\s*(?:月|[\/\-])\s*\d{1,2}\s*[日號]?/g, " ")
    .replace(/^[，,。！!？?\s]+/g, "")
    .replace(/[，,。！!？?\s]+$/g, "")
    .trim();
}

/**
 * 解析週期性排程語法；不是週期性回 null。
 *  - 每天 08:00 / 平日 22:30 / 週末 10:00 / 星期一 09:00 / 每週一 09:00 / 每月 5 號 10:00
 *  - 每隔 3 小時 / 每隔 90 分鐘
 *  - 農曆 7/15 09:00（舊曆生日/紀念日）
 */
export function parseRecurring(args: string): Recurring | null {
  // 農曆生日 / 舊曆紀念日
  const lunar = /農曆\s*(\d{1,2})\s*(?:月|[\/\-])\s*(\d{1,2})\s*[日號]?/.exec(args);
  if (lunar) {
    const month = Number(lunar[1]);
    const day = Number(lunar[2]);
    if (month < 1 || month > 12 || day < 1 || day > 30) return null;
    const content = stripSchedule(args, true);
    if (!content) return null;
    const at = timeOf(args) ?? { hh: 9, mm: 0 };
    const time = `${pad(at.hh)}:${pad(at.mm)}`;
    return { label: `農曆 ${month}/${day} ${time}`, content, watch: { lunar: { month, day }, at: time } };
  }

  const content = stripSchedule(args);
  if (!content) return null;

  // 每隔 N 分鐘 / N 小時
  const every = /(?:每隔|每)\s*(\d{1,4})\s*(分鐘|小時|分|時)/.exec(args);
  if (every) {
    const n = Number(every[1]);
    const minutes = every[2].includes("小時") || every[2] === "時" ? n * 60 : n;
    if (minutes < 1 || minutes > 1440) return null;
    if (minutes > 60 && minutes % 60 !== 0) return null; // 底層排程僅支援 60 的倍數
    const label = minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小時` : `每 ${minutes} 分鐘`;
    return { label, content, watch: { everyMinutes: minutes } };
  }

  const at = timeOf(args);
  if (!at) return null;
  const time = `${pad(at.hh)}:${pad(at.mm)}`;

  if (/每天|每日/.test(args)) {
    return { label: `每天 ${time}`, content, watch: { cron: `${at.mm} ${at.hh} * * *` } };
  }
  if (/平日|工作日/.test(args)) {
    return { label: `平日 ${time}`, content, watch: { cron: `${at.mm} ${at.hh} * * 1-5` } };
  }
  if (/週末|週六|週日|假日/.test(args)) {
    return { label: `週末 ${time}`, content, watch: { cron: `${at.mm} ${at.hh} * * 6,0` } };
  }

  const weekly = /(每週|每星期|礼拜?|星期)\s*([一二三四五六日天])/.exec(args);
  if (weekly) {
    const dow = WEEKDAY_CN[weekly[2]];
    const label = weekly[1].startsWith("每") ? `每週${weekly[2]} ${time}` : `星期${weekly[2]} ${time}`;
    return { label, content, watch: { cron: `${at.mm} ${at.hh} * * ${dow}` } };
  }

  const monthly = /每月\s*(\d{1,2})\s*(號|日)/.exec(args);
  if (monthly) {
    const dom = Number(monthly[1]);
    if (dom < 1 || dom > 31) return null;
    return { label: `每月 ${dom} 號 ${time}`, content, watch: { cron: `${at.mm} ${at.hh} ${dom} * *` } };
  }

  return null;
}

/** 任務名稱：內容＋排程的雜湊，確保同內容不同時間可並存、同內容同時間自動取代。 */
function taskNameOf(content: string, watch: Recurring["watch"]): string {
  const sig =
    "cron" in watch
      ? watch.cron.replace(/\s+/g, "_")
      : "everyMinutes" in watch
        ? `e${watch.everyMinutes}`
        : "lunar" in watch
          ? `l${watch.lunar.month}-${watch.lunar.day}-${watch.at}`
          : `a${watch.at}`;
  const h = createHash("sha1").update(`${content}|${sig}`).digest("hex").slice(0, 8);
  return `r-${h}`;
}

function describeCron(cron: string): string {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;
  if (/^\*\d+$/.test(min) && hour === "*" && dom === "*") return `每 ${min.slice(1)} 分鐘`;
  if (min === "*" && hour === "*") return "每分鐘";
  if (hour === "*" && dom === "*") return `每小時 ${pad(Number(min))} 分`;
  if (min === "0" && hour === "*") return "每小時";
  if (dom === "*" && dow === "*") return `每天 ${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === "*" && dow === "1-5") return `平日 ${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === "*" && dow === "6,0") return `週末 ${pad(Number(hour))}:${pad(Number(min))}`;
  if (dom === "*" && /^\d$/.test(dow))
    return `每週${["日", "一", "二", "三", "四", "五", "六"][Number(dow)]} ${pad(Number(hour))}:${pad(Number(min))}`;
  if (dow === "*" && /^\d+$/.test(dom)) return `每月 ${Number(dom)} 號 ${pad(Number(hour))}:${pad(Number(min))}`;
  return cron;
}

function renderWatches(watches: SkillWatchView[]): string {
  return watches
    .map((w) => {
      const text = typeof w.args?.text === "string" ? w.args.text : "（無內容）";
      const lunarTag = w.args?.lunarMonth ? `｜農曆 ${w.args.lunarMonth}/${w.args.lunarDay}` : "";
      const runAt = w.runAt ? w.runAt.slice(5, 16).replace("T", " ") : "";
      return `・${text}｜${describeCron(w.cron)}${lunarTag}｜下次 ${runAt}`;
    })
    .join("\n");
}

function todayLunar(): { month: number; day: number } {
  const now = nowInTz();
  return solarToLunar(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

const remindSkill: SkillDefinition = {
  id: "remind",
  name: "提醒 / 倒數",
  description: {
    zh: "一次性或週期性提醒（每天、平日、每週、每月、每隔 N 小時、農曆生日）。",
    en: "One-off or recurring reminders (daily, weekdays, weekly, monthly, every N hours, lunar birthdays).",
    ja: "一回きりまたは定期リマインダー（毎日・平日・毎週・毎月・N時間毎・旧暦誕生日）。",
  },
  usage: {
    zh: "提醒 30分鐘後 喝水；提醒 明天 09:00 開會；提醒 每天 08:00 吃藥；提醒 星期一 09:00 開會；提醒 每月 5 號 10:00 繳房租；提醒 每隔 3 小時 喝水；提醒 農曆 7/15 09:00 中元節；提醒 清單；提醒 取消 吃藥",
    en: "remind in 30 min water; remind tomorrow 09:00 meeting; remind daily 08:00 pills; remind Monday 09:00 meeting; remind monthly 5th 10:00 rent; remind every 3 hours water; remind lunar 7/15 09:00; remind list; remind cancel pills",
    ja: "リマインド 30分後 水；リマインド 明日 09:00 会議；リマインド 毎日 08:00 薬；リマインド 毎週月曜 09:00 会議；リマインド 毎月5日 10:00 家賃；リマインド 3時間毎 水；リマインド 旧暦 7/15 09:00；リマインド 一覧；リマインド 取消 薬",
  },
  category: { zh: "工具", en: "Tools", ja: "ツール" },
  defaultTrigger: "提醒",
  triggerAliases: ["倒數", "提醒我", "定時"],
  fields: [],
  async run(ctx: SkillContext): Promise<void> {
    const args = ctx.args.trim();

    // 清單
    if (/^(清單|列表|list)$/i.test(args)) {
      const watches = ctx.watches();
      if (watches.length === 0) {
        await ctx.reply("目前沒有週期性提醒。\n用法：提醒 每天 08:00 吃藥");
        return;
      }
      await ctx.reply(`週期性提醒（${watches.length}）：\n${renderWatches(watches)}`);
      return;
    }

    // 取消（全部或依關鍵字）
    const cancel = /^(取消|退訂|刪除|delete)\s*(.*)$/i.exec(args);
    if (cancel) {
      const watches = ctx.watches();
      if (watches.length === 0) {
        await ctx.reply("目前沒有週期性提醒可以取消。");
        return;
      }
      const keyword = cancel[2].trim();
      if (/全部|所有|all/i.test(keyword) || keyword === "") {
        for (const w of watches) ctx.unwatch(w.id);
        await ctx.reply(`已取消全部 ${watches.length} 個週期性提醒。`);
        return;
      }
      const hit = watches.filter((w) => typeof w.args?.text === "string" && (w.args.text as string).includes(keyword));
      if (hit.length === 0) {
        await ctx.reply(`找不到含「${keyword}」的週期性提醒，可用「提醒 清單」查看。`);
        return;
      }
      for (const w of hit) ctx.unwatch(w.id);
      const names = hit.map((w) => w.args?.text).join("、");
      await ctx.reply(`已取消 ${hit.length} 個提醒：${names}`);
      return;
    }

    if (!args) {
      await ctx.reply(
        "用法：\n提醒 30分鐘後 喝水（單次）\n提醒 明天 09:00 開會（單次）\n提醒 每天 08:00 吃藥\n提醒 平日 22:30 睡覺\n提醒 星期一 09:00 開會\n提醒 每月 5 號 10:00 繳房租\n提醒 每隔 3 小時 喝水\n提醒 農曆 7/15 09:00 中元節\n提醒 清單｜提醒 取消 吃藥",
      );
      return;
    }

    // 「每隔 N 分鐘」的合法性（>60 需為 60 的倍數）先明確擋下，避免落入單次解析
    const everyCheck = /(?:每隔|每)\s*(\d{1,4})\s*(分鐘|小時|分|時)/.exec(args);
    if (everyCheck) {
      const n = Number(everyCheck[1]);
      const minutes = everyCheck[2].includes("小時") || everyCheck[2] === "時" ? n * 60 : n;
      if (minutes > 1440 || (minutes > 60 && minutes % 60 !== 0)) {
        await ctx.reply("「每隔 N 分鐘」僅支援 1–60 或 60 的倍數（≤1440），例如：每隔 3 小時、每隔 45 分鐘。");
        return;
      }
    }

    // 週期性提醒
    const rec = parseRecurring(args);
    if (rec) {
      if ("lunar" in rec.watch) {
        const { month, day } = rec.watch.lunar;
        ctx.watch({
          task: taskNameOf(rec.content, rec.watch),
          at: rec.watch.at,
          args: { text: rec.content, lunarMonth: month, lunarDay: day },
          state: {},
        });
        logger.info("已建立農曆提醒", { chat: ctx.chat, month, day, at: rec.watch.at });
        await ctx.reply(`好的，每年${rec.label} 提醒你：「${rec.content}」`);
        return;
      }
      const opts =
        "cron" in rec.watch
          ? { cron: rec.watch.cron }
          : "everyMinutes" in rec.watch
            ? { everyMinutes: rec.watch.everyMinutes }
            : { at: rec.watch.at };
      try {
        ctx.watch({ task: taskNameOf(rec.content, rec.watch), ...opts, args: { text: rec.content } });
      } catch (error) {
        await ctx.reply(`排程無效：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      logger.info("已建立週期提醒", { chat: ctx.chat, rec: rec.label, content: rec.content });
      await ctx.reply(`好的，將於${rec.label} 提醒你：「${rec.content}」（「提醒 取消 ${rec.content}」可取消）`);
      return;
    }

    // 單次提醒
    const parsed = parseWhen(args);
    if ("error" in parsed) {
      await ctx.reply("用法：提醒 30分鐘後 喝水，或 提醒 明天 09:00 開會\n週期性：提醒 每天 08:00 吃藥");
      return;
    }

    // 取出提醒內容：移除時間片段後剩下的文字
    const content = args
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
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const text = typeof ctx.args?.text === "string" ? ctx.args.text : "時間到了！";

    // 農曆任務底層是每日排程：只有農曆日期對得上才推播。
    const lm = Number(ctx.args?.lunarMonth);
    const ld = Number(ctx.args?.lunarDay);
    if (Number.isInteger(lm) && lm > 0 && Number.isInteger(ld) && ld > 0) {
      const today = todayLunar();
      if (today.month !== lm || today.day !== ld) return;
    }
    await ctx.reply(`⏰ ${text}`);
  },
};

export default remindSkill;
