import { logger } from "../../logger.js";
import { config } from "../../config.js";
import { nowInTz } from "../../time.js";
import { parseTtl } from "../cache.js";
import { solarToLunar, monthName, dayName, ganzhi, zodiac } from "../lunar/index.js";
import { fetchWeather } from "../weather/index.js";
import { getPrices } from "../oil-price/index.js";
import { getReading, aqiLevel } from "../air-quality/index.js";
import { fetchChart } from "../stock/index.js";
import { getRates } from "../exchange-rate/index.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";
import { describeWatch } from "../watch.js";

const TASK = "daily";
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 讀取兄弟技能的設定（晨報沿用天氣/空品技能已填好的 key）。 */
function siblingConfig(id: string): Record<string, string> {
  return config.skills.find((s) => s.id === id)?.config ?? {};
}

function cityOf(ctx: { config: Record<string, string> }, override?: string): string {
  return (override || ctx.config.city || "台北").trim();
}

async function compose(city: string): Promise<string> {
  const now = nowInTz();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 星期${WEEKDAYS[now.getDay()]}`;
  const l = solarToLunar(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const lines = [
    `【${dateStr} 早安晨報】`,
    `農曆${monthName(l.month, l.isLeap)}${dayName(l.day)}（${ganzhi(l.year)}年・${zodiac(l.year)}）`,
  ];

  try {
    const wc = siblingConfig("weather");
    const r = await fetchWeather(city, wc.cwaKey ?? "", parseTtl(wc.cacheTtl, 60));
    const feels = r.feelsC !== undefined && Number.isFinite(r.feelsC) ? `（體感${r.feelsC}°C）` : "";
    lines.push(`天氣 ${r.city}：${r.tempC}°C${feels} ${r.desc}`);
  } catch (error) {
    logger.warn("晨報天氣失敗", { error: error instanceof Error ? error.message : String(error) });
    lines.push("天氣：暫無資料");
  }

  try {
    const ac = siblingConfig("air-quality");
    const { reading } = await getReading(city, (ac.waqiToken ?? "").trim());
    lines.push(`空品 AQI ${reading.aqi}（${aqiLevel(reading.aqi)}）`);
  } catch (error) {
    logger.warn("晨報空品失敗", { error: error instanceof Error ? error.message : String(error) });
    lines.push("空品：暫無資料");
  }

  try {
    const prices = await getPrices(360 * 60 * 1000);
    const pick = (re: RegExp) => prices.find((p) => re.test(p.name));
    const parts: string[] = [];
    const p92 = pick(/92/);
    const p95 = pick(/95/);
    const p98 = pick(/98/);
    const diesel = pick(/柴油/);
    if (p92) parts.push(`92 ${p92.price.toFixed(1)}`);
    if (p95) parts.push(`95 ${p95.price.toFixed(1)}`);
    if (p98) parts.push(`98 ${p98.price.toFixed(1)}`);
    if (diesel) parts.push(`柴油 ${diesel.price.toFixed(1)}`);
    lines.push(parts.length > 0 ? `油價 ${parts.join("／")}` : "油價：暫無資料");
  } catch (error) {
    logger.warn("晨報油價失敗", { error: error instanceof Error ? error.message : String(error) });
    lines.push("油價：暫無資料");
  }

  try {
    const { meta } = await fetchChart("^TWII", "1d");
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    if (price !== undefined && Number.isFinite(price) && prev) {
      const diff = price - prev;
      const pct = ((diff / prev) * 100).toFixed(2);
      const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "＝";
      lines.push(
        `台股 ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${arrow}${Math.abs(diff).toFixed(2)} (${diff >= 0 ? "+" : ""}${pct}%)`,
      );
    } else if (price !== undefined) {
      lines.push(`台股 ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
    } else {
      lines.push("台股：暫無資料");
    }
  } catch (error) {
    logger.warn("晨報台股失敗", { error: error instanceof Error ? error.message : String(error) });
    lines.push("台股：暫無資料");
  }

  try {
    const data = await getRates("USD", 360 * 60 * 1000);
    const rate = data.rates.TWD;
    lines.push(Number.isFinite(rate) ? `美金 ${rate.toFixed(2)}` : "匯率：暫無資料");
  } catch (error) {
    logger.warn("晨報匯率失敗", { error: error instanceof Error ? error.message : String(error) });
    lines.push("匯率：暫無資料");
  }

  return lines.join("\n");
}

const morningSkill: SkillDefinition = {
  id: "morning",
  name: "晨報",
  description: {
    zh: "每天固定時間推送早安晨報（天氣/空品/油價/台股/匯率/農曆）。",
    en: "Daily morning digest (weather/AQI/gas prices/TAIEX/FX/lunar date).",
    ja: "毎朝のモーニングダイジェスト（天気/AQI/ガソリン/株価/為替/旧暦）。",
  },
  usage: {
    zh: "晨報 08:00 高雄",
    en: "morning 08:00",
    ja: "晨報 08:00",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "晨報",
  triggerAliases: ["早安", "早報", "morning"],
  fields: [
    {
      key: "city",
      label: { zh: "預設城市", en: "Default city", ja: "既定の都市" },
      hint: "例如 台北；指令中也可直接指定（晨報 08:00 高雄）",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "晨報", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    // 取消
    if (/取消|刪除|停止|關閉/.test(ctx.args)) {
      const ok = ctx.unwatch(TASK);
      await ctx.reply(ok ? "已取消晨報。" : "目前沒有設定晨報。");
      return;
    }
    // 立即來一份
    if (/現在|立刻|馬上|一次/.test(ctx.args)) {
      const city = cityOf(ctx, extractCity(ctx.args));
      await ctx.reply(await compose(city));
      return;
    }
    // 狀態
    if (/狀態|查詢|清單/.test(ctx.args)) {
      const jobs = ctx.watches().filter((w) => w.task === TASK);
      if (jobs.length === 0) {
        await ctx.reply("目前沒有設定晨報。用法：阿寶請幫忙 晨報 08:00 高雄");
        return;
      }
      await ctx.reply(`晨報設定：每天 ${cronToTime(jobs[0].cron)}（${cityOf(ctx, String(jobs[0].args.city ?? ""))}）`);
      return;
    }

    const time = /(\d{1,2})[:：](\d{2})/.exec(ctx.args);
    if (!time) {
      await ctx.reply("用法：阿寶請幫忙 晨報 08:00 高雄（取消：晨報 取消；立即：晨報 現在）");
      return;
    }
    const hh = Number(time[1]);
    const mm = time[2];
    if (hh > 23) {
      await ctx.reply("時間格式錯誤，請用 HH:mm（例如 08:00）。");
      return;
    }
    const at = `${String(hh).padStart(2, "0")}:${mm}`;
    const city = cityOf(ctx, extractCity(ctx.args));
    const view = ctx.watch({ task: TASK, at, args: { city }, state: {} });
    void view;
    await ctx.reply(`已設定晨報：每天 ${at} 推送（${city}，${describeWatch({ task: TASK, at })}）`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const city = String(ctx.args.city || "台北");
    try {
      await ctx.reply(await compose(city));
    } catch (error) {
      logger.error("晨報推送失敗", { error: error instanceof Error ? error.message : String(error) });
    }
  },
};

/** 從參數中取出城市（移除指令字與時間後剩下的文字）。 */
function extractCity(args: string): string {
  return args
    .replace(/請幫忙|請幫|幫忙|查詢|晨報|早安|早報|morning|取消|刪除|停止|關閉|現在|立刻|馬上|一次|狀態|查詢|清單|的/g, " ")
    .replace(/\d{1,2}[:：]\d{2}/g, " ")
    .trim();
}

/** "0 8 * * *" → "08:00"（顯示用）。 */
function cronToTime(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim());
  if (!m) return cron;
  return `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
}

export default morningSkill;
