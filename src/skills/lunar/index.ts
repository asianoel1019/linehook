import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import type { SkillContext, SkillDefinition } from "../types.js";

// 1900-2100 農曆資料表（每年一個 16 進位值：低 4 位為閏月，其餘為 12 個月大小月）。
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

const GAN = "甲乙丙丁戊己庚辛壬癸";
const ZHI = "子丑寅卯辰巳午未申酉戌亥";
const ZODIAC = "鼠牛虎兔龍蛇馬羊猴雞狗豬";
const MONTH_DAY_BASE = Date.UTC(1900, 0, 31); // 1900-01-31 = 農曆 1900 正月初一

export function leapMonth(y: number): number {
  return LUNAR_INFO[y - 1900] & 0xf;
}

function leapDays(y: number): number {
  if (!leapMonth(y)) return 0;
  return LUNAR_INFO[y - 1900] & 0x10000 ? 30 : 29;
}

export function monthDays(y: number, m: number): number {
  return LUNAR_INFO[y - 1900] & (0x10000 >> m) ? 30 : 29;
}

function yearDays(y: number): number {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += LUNAR_INFO[y - 1900] & i ? 1 : 0;
  return sum + leapDays(y);
}

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

export function solarToLunar(y: number, m: number, d: number): LunarDate {
  let offset = (Date.UTC(y, m - 1, d) - MONTH_DAY_BASE) / 86400000;
  let i: number;
  let temp = 0;
  for (i = 1900; i < 2101 && offset > 0; i++) {
    temp = yearDays(i);
    offset -= temp;
  }
  if (offset < 0) {
    offset += temp;
    i--;
  }
  const year = i;
  const leap = leapMonth(year);
  let isLeap = false;
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i === leap + 1 && !isLeap) {
      --i;
      isLeap = true;
      temp = leapDays(year);
    } else {
      temp = monthDays(year, i);
    }
    if (isLeap && i === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) isLeap = false;
    else {
      isLeap = true;
      --i;
    }
  }
  if (offset < 0) {
    offset += temp;
    --i;
  }
  return { year, month: i, day: offset + 1, isLeap };
}

export function lunarToSolar(input: LunarDate): Date {
  const { year, month, isLeap } = input;
  const leap = leapMonth(year);
  let offset = 0;
  for (let i = 1900; i < year; i++) offset += yearDays(i);
  if (isLeap && leap === month) {
    for (let i = 1; i <= month; i++) offset += monthDays(year, i);
  } else {
    for (let i = 1; i < month; i++) {
      offset += monthDays(year, i);
      if (leap > 0 && i === leap) offset += leapDays(year);
    }
  }
  offset += input.day - 1;
  return new Date(MONTH_DAY_BASE + offset * 86400000);
}

export function monthName(m: number, isLeap: boolean): string {
  const names = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  return `${isLeap ? "閏" : ""}${names[m - 1]}月`;
}

export function dayName(d: number): string {
  const cn = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (d === 10) return "初十";
  if (d === 20) return "二十";
  if (d === 30) return "三十";
  if (d < 10) return `初${cn[d]}`;
  if (d < 20) return `十${cn[d - 10]}`;
  return `廿${cn[d - 20]}`;
}

export function ganzhi(year: number): string {
  return GAN[(year - 4) % 10] + ZHI[(year - 4) % 12];
}

export function zodiac(year: number): string {
  return ZODIAC[(year - 4) % 12];
}

function fmtSolar(d: Date): string {
  const p = (n: number) => ("0" + n).slice(-2);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function lunarLabel(l: LunarDate): string {
  return `${ganzhi(l.year)}年（${zodiac(l.year)}）${monthName(l.month, l.isLeap)}${dayName(l.day)}`;
}

/** 解析「今天/明天/後天」或 YYYY-MM-DD / M/D 為國曆日期。 */
function parseSolar(text: string): Date | null {
  const now = nowInTz();
  if (/今天|今日/.test(text)) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (/明天|明日/.test(text)) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  if (/後天/.test(text)) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 2));
  const ymd = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (ymd) return new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
  const md = text.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (md) return new Date(Date.UTC(now.getFullYear(), Number(md[1]) - 1, Number(md[2])));
  return null;
}

/** 解析農曆輸入：年（可選）月、日，支援中文與數字。 */
function parseLunar(text: string): LunarDate | null {
  const now = nowInTz();
  const yearMatch = text.match(/(\d{4})\s*年?/) || text.match(/年/);
  let year = yearMatch ? Number((yearMatch[1] ?? "").trim()) : NaN;

  const isLeap = /閏/.test(text);

  // 國字月份
  const cnMonths: Record<string, number> = {
    正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
  };
  let month = NaN;
  const mCn = text.match(/(閏)?(正|十一|十二|十|一|二|三|四|五|六|七|八|九)月/);
  if (mCn) month = cnMonths[mCn[2]];
  if (!Number.isFinite(month)) {
    const mNum = text.match(/(\d{1,2})\s*月/);
    if (mNum) month = Number(mNum[1]);
  }
  if (!Number.isFinite(month)) {
    const mIso = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (mIso) {
      if (!Number.isFinite(year)) year = Number(mIso[1]);
      month = Number(mIso[2]);
    }
  }

  // 日
  let day = NaN;
  const dCn: Record<string, number> = {
    初一: 1, 初二: 2, 初三: 3, 初四: 4, 初五: 5, 初六: 6, 初七: 7, 初八: 8, 初九: 9, 初十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
    二十: 20, 廿一: 21, 廿二: 22, 廿三: 23, 廿四: 24, 廿五: 25, 廿六: 26, 廿七: 27, 廿八: 28, 廿九: 29,
    三十: 30,
  };
  const dMatch = text.match(/(初一|初二|初三|初四|初五|初六|初七|初八|初九|初十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十|廿一|廿二|廿三|廿四|廿五|廿六|廿七|廿八|廿九|三十)/);
  if (dMatch) day = dCn[dMatch[1]];
  if (!Number.isFinite(day)) {
    const dNum = text.match(/(\d{1,2})\s*日/);
    if (dNum) day = Number(dNum[1]);
    else {
      const iso = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
      if (iso) day = Number(iso[3]);
    }
  }

  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (!Number.isFinite(year)) {
    const inTz = nowInTz();
    const l = solarToLunar(inTz.getFullYear(), inTz.getMonth() + 1, inTz.getDate());
    year = l.year;
  }
  if (year < 1901 || year > 2100) return null;
  return { year, month, day, isLeap };
}

const lunarSkill: SkillDefinition = {
  id: "lunar",
  name: "農曆 / 國曆轉換",
  description: {
    zh: "查詢農曆日期、天干地支與生肖。",
    en: "Convert between Gregorian and Chinese lunar dates (with zodiac).",
    ja: "新暦と旧暦（農暦）を変換します（干支・干支獣つき）。",
  },
  usage: {
    zh: "國曆 2026-09-28 或 農曆 2026 八月初七",
    en: "lunar 2026-09-28 or lunar 2026 8/7",
    ja: "農暦 2026-09-28 または 農暦 2026 八月初七",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "農曆",
  triggerAliases: ["農民曆", "國曆", "陰曆", "lunar", "農曆轉換"],
  fields: [],
  async run(ctx: SkillContext): Promise<void> {
    const text = ctx.args
      .replace(/請幫忙|請幫|幫忙|幫我|查詢|查一下|轉換|換成|的|是|幾號|日期/g, " ")
      .trim();

    const isLunarInput = /農曆|農民曆|陰曆|舊曆|閏|初[一二三四五六七八九十]|廿|正月/.test(ctx.args);

    try {
      if (isLunarInput) {
        const lunar = parseLunar(text);
        if (!lunar) {
          await ctx.reply("請提供農曆日期，例如：阿寶請幫忙 農曆 2026 八月初七");
          return;
        }
        if (lunar.day > monthDays(lunar.year, lunar.month)) {
          await ctx.reply("這個農曆日期不存在（該月沒有這一天）。");
          return;
        }
        const solar = lunarToSolar(lunar);
        const roundTrip = solarToLunar(solar.getUTCFullYear(), solar.getUTCMonth() + 1, solar.getUTCDate());
        if (roundTrip.year !== lunar.year || roundTrip.month !== lunar.month || roundTrip.day !== lunar.day) {
          await ctx.reply("查無此農曆日期，請確認是否有閏月或日期有誤。");
          return;
        }
        logger.info("農曆轉國曆", { lunar });
        await ctx.reply(`農曆 ${lunarLabel(lunar)} → 國曆 ${fmtSolar(solar)}`);
        return;
      }

      const solar = parseSolar(text);
      if (!solar) {
        await ctx.reply("請提供日期，例如：阿寶請幫忙 國曆 2026-09-28 或 農曆 2026 八月初七");
        return;
      }
      const lunar = solarToLunar(solar.getUTCFullYear(), solar.getUTCMonth() + 1, solar.getUTCDate());
      logger.info("國曆轉農曆", { solar: fmtSolar(solar) });
      await ctx.reply(`國曆 ${fmtSolar(solar)} → 農曆 ${lunarLabel(lunar)}`);
    } catch (error) {
      logger.error("農曆轉換失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("日期轉換失敗，請確認格式。");
    }
  },
};

export default lunarSkill;
