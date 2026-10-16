import { config } from "@lw/config";
import { nowInTz, zonedTimeToMs } from "@lw/time";

export interface ParsedDateTime {
  runAt: number;
  when: Date;
  /** 被吃掉的時間片段（呼叫端可用來從內容移除）。 */
  matched: string[];
}

export interface ParseOptions {
  /** 以此為「現在」（預設 nowInTz()）。 */
  now?: Date;
  /** 相對時間基準 ms（預設 Date.now()）。 */
  nowMs?: number;
  timeZone?: string;
  /** 只有日期沒有時間時的預設（預設 09:00）。 */
  defaultTime?: { hh: number; mm: number };
}

const NUM = "[0-9一二三四五六七八九兩十]{1,3}";
const WEEKDAY_CN: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 中文數字轉阿拉伯（支援 一～三十一、十、二十、兩）。 */
export function chineseNumToInt(s: string): number | null {
  const t = s.trim().replace(/兩/g, "二");
  if (/^\d+$/.test(t)) return Number(t);
  const digit: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === "十") return 10;
  const m = /^(一|二|三|四|五|六|七|八|九)?十(一|二|三|四|五|六|七|八|九)?$/.exec(t);
  if (m) {
    const tens = m[1] ? digit[m[1]] * 10 : 10;
    return tens + (m[2] ? digit[m[2]] : 0);
  }
  if (t.length === 1 && digit[t]) return digit[t];
  return null;
}

interface FoundDate {
  year: number;
  month: number;
  day: number;
  /** 明確寫出年月日（M/D、X月X日、YYYY-M-D）：過期走次年而非順延一天。 */
  explicit: boolean;
  matched: string;
}

function findDate(text: string, now: Date): FoundDate | null {
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const d = now.getDate();
  const at = (offset: number): FoundDate => {
    const dt = new Date(y, mo - 1, d + offset);
    return { year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate(), explicit: false, matched: "" };
  };

  const rel = /大後天|後天|明天|明日|今天|今日/.exec(text);
  if (rel) {
    const off = rel[0] === "大後天" ? 3 : rel[0] === "後天" ? 2 : rel[0] === "明天" || rel[0] === "明日" ? 1 : 0;
    return { ...at(off), matched: rel[0] };
  }

  const nextWeek = /下(?:週|周|星期|禮拜|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (nextWeek && WEEKDAY_CN[nextWeek[1]] !== undefined) {
    const off = ((WEEKDAY_CN[nextWeek[1]] - now.getDay() + 7) % 7) || 7;
    return { ...at(off), matched: nextWeek[0] };
  }

  const thisWeek = /(?<![下])(?:週|周|星期|禮拜|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (thisWeek && WEEKDAY_CN[thisWeek[1]] !== undefined) {
    const off = (WEEKDAY_CN[thisWeek[1]] - now.getDay() + 7) % 7;
    return { ...at(off), matched: thisWeek[0] };
  }

  const cnMd = new RegExp(`(${NUM})\\s*月\\s*(${NUM})\\s*[日號]?`).exec(text);
  if (cnMd) {
    const month = chineseNumToInt(cnMd[1]);
    const day = chineseNumToInt(cnMd[2]);
    if (month !== null && day !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year: y, month, day, explicit: true, matched: cnMd[0] };
    }
  }

  const ymd = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(text);
  if (ymd) {
    return {
      year: Number(ymd[1]),
      month: Number(ymd[2]),
      day: Number(ymd[3]),
      explicit: true,
      matched: ymd[0],
    };
  }
  const md = /(\d{1,2})[\/\-](\d{1,2})/.exec(text);
  if (md) {
    return { year: y, month: Number(md[1]), day: Number(md[2]), explicit: true, matched: md[0] };
  }
  return null;
}

/** 日期部分解析（待辦期限、倒數日期用）：回 YYYY-MM-DD 與吃掉的片段。 */
export function parseDateOnly(
  text: string,
  opts?: Pick<ParseOptions, "now" | "timeZone">,
): { ymd: string; matched: string } | null {
  const now = opts?.now ?? nowInTz();
  const found = findDate(text, now);
  if (!found) return null;
  if (found.month < 1 || found.month > 12 || found.day < 1 || found.day > 31) return null;
  const p = (n: number): string => String(n).padStart(2, "0");
  return { ymd: `${found.year}-${p(found.month)}-${p(found.day)}`, matched: found.matched };
}

const PERIODS = "(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|深夜|半夜)";

/** 套用時段詞（下午3點→15）：回 null 表示數字不合法。 */
function applyPeriod(period: string, h: number): number | null {
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (/凌晨|清晨|半夜|深夜/.test(period)) return h === 12 ? 0 : h;
  if (/早上|上午/.test(period)) return h;
  if (/中午/.test(period)) {
    if (h === 12) return 12;
    if (h >= 1 && h <= 9) return h + 12;
    return h;
  }
  if (/下午|傍晚|晚上/.test(period)) return h < 12 ? h + 12 : h;
  return h;
}

/**
 * 自然語言日期時間解析（共用：提醒／待辦／倒數）。
 * 支援：N秒/分鐘/小時/天後；今天/明天/後天/大後天；下週X/週X/星期X；
 * X月X日、M/D、YYYY-M-D；早上/下午/晚上 X點(半)/X點Y分/HH:mm、裸 X點。
 * 沒有時間時用 defaultTime（09:00）；已過的時間順延（明確日期走次年）。
 */
export function parseDateTime(text: string, opts?: ParseOptions): ParsedDateTime | null {
  const tz = opts?.timeZone ?? config.timezone;
  const now = opts?.now ?? nowInTz();
  const nowMs = opts?.nowMs ?? Date.now();
  const def = opts?.defaultTime ?? { hh: 9, mm: 0 };

  const rel = text.match(/(\d+(?:\.\d+)?)\s*(秒|分鐘|分|小時|時|天)\s*(?:後|之後)?/);
  if (rel) {
    const n = Number(rel[1]);
    const ms =
      rel[2] === "秒"
        ? n * 1000
        : rel[2].includes("分")
          ? n * 60_000
          : rel[2].includes("小時") || rel[2] === "時"
            ? n * 3600_000
            : n * 86400_000;
    if (ms > 0) {
      const runAt = nowMs + ms;
      return { runAt, when: new Date(runAt), matched: [rel[0]] };
    }
  }

  const found = findDate(text, now);
  const base = found ?? {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    explicit: false,
    matched: "",
  };
  if (base.month < 1 || base.month > 12 || base.day < 1 || base.day > 31) return null;

  // 時間：HH:mm 優先（含「下午 3:30」這種時段詞在前的寫法）
  const clock = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (clock) {
    let hh = Number(clock[1]);
    const mm = Number(clock[2]);
    if (mm > 59) return null;
    const before = text.slice(0, clock.index);
    const period = new RegExp(`${PERIODS}\\s*$`).exec(before)?.[1];
    if (period) {
      const adjusted = applyPeriod(period, hh);
      if (adjusted === null) return null;
      hh = adjusted;
    }
    if (hh > 23) return null;
    return finish(base, hh, mm, tz, nowMs, todayParts(now), found ? [found.matched, clock[0]] : [clock[0]]);
  }

  // 時段詞＋X點（半）/X點Y分
  const withPeriod = new RegExp(`${PERIODS}\\s*(${NUM})\\s*[點点時](?:\\s*(半)|\\s*(${NUM})\\s*分)?`).exec(text);
  if (withPeriod) {
    const h = chineseNumToInt(withPeriod[2]);
    if (h === null) return null;
    const hh = applyPeriod(withPeriod[1], h);
    if (hh === null) return null;
    const mm = withPeriod[3] ? 30 : withPeriod[4] ? chineseNumToInt(withPeriod[4]) : 0;
    if (mm === null || mm > 59) return null;
    return finish(base, hh, mm, tz, nowMs, todayParts(now), found ? [found.matched, withPeriod[0]] : [withPeriod[0]]);
  }

  // 裸 X點（半）/X點Y分：今天 h 點、h+12 點、明天 h 點，取第一個未來的
  const bare = new RegExp(`(${NUM})\\s*[點点]\\s*(半|(${NUM})\\s*分)?`).exec(text);
  if (bare) {
    const h = chineseNumToInt(bare[1]);
    if (h === null || h > 23) return null;
    const mm = bare[2] ? 30 : bare[3] ? chineseNumToInt(bare[3]) : 0;
    if (mm === null || mm > 59) return null;
    const cands = h < 12 ? [h, h + 12] : [h];
    for (const hh of cands) {
      const runAt = zonedTimeToMs(
        { year: base.year, month: base.month, day: base.day, hour: hh, minute: mm },
        tz,
      );
      if (runAt > nowMs) {
        return { runAt, when: new Date(runAt), matched: found ? [found.matched, bare[0]] : [bare[0]] };
      }
    }
    const runAt = zonedTimeToMs(
      { year: base.year, month: base.month, day: base.day + 1, hour: h, minute: mm },
      tz,
    );
    return { runAt, when: new Date(runAt), matched: found ? [found.matched, bare[0]] : [bare[0]] };
  }

  // 只有日期：用預設時間
  if (found) {
    return finish(base, def.hh, def.mm, tz, nowMs, todayParts(now), [found.matched]);
  }
  return null;
}

/** 取「今天」的年月日（沿用 now 的本地欄位，與呼叫端一致）。 */
function todayParts(now: Date): { year: number; month: number; day: number } {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** 組出 runAt；已過則順延（明確日期＋1 年，其餘＋1 天）。 */
function finish(
  base: { year: number; month: number; day: number; explicit: boolean },
  hh: number,
  mm: number,
  tz: string,
  nowMs: number,
  today: { year: number; month: number; day: number },
  matched: string[],
): ParsedDateTime {
  let runAt = zonedTimeToMs({ year: base.year, month: base.month, day: base.day, hour: hh, minute: mm }, tz);
  if (runAt <= nowMs) {
    if (base.explicit) {
      // 明確日期：同日已過順延一天，否則走次年
      const sameDay = base.year === today.year && base.month === today.month && base.day === today.day;
      runAt = sameDay
        ? zonedTimeToMs({ year: base.year, month: base.month, day: base.day + 1, hour: hh, minute: mm }, tz)
        : zonedTimeToMs({ year: base.year + 1, month: base.month, day: base.day, hour: hh, minute: mm }, tz);
    } else {
      runAt = zonedTimeToMs({ year: base.year, month: base.month, day: base.day + 1, hour: hh, minute: mm }, tz);
    }
  }
  return { runAt, when: new Date(runAt), matched: matched.filter(Boolean) };
}
