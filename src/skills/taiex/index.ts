import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchChart } from "../stock/index.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const CACHE_NAME = "taiex";

export interface IndexQuote {
  price: number;
  change: number;
  pct: number;
  prev: number;
  high?: number;
  low?: number;
}

export function toQuote(symbol: string, meta: {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketChangePercent?: number;
}): IndexQuote | null {
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  if (price === undefined || !Number.isFinite(price) || !prev) return null;
  const change = price - prev;
  const pct = meta.regularMarketChangePercent ?? (change / prev) * 100;
  void symbol;
  return { price, change, pct, prev, high: meta.regularMarketDayHigh, low: meta.regularMarketDayLow };
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const taiexSkill: SkillDefinition = {
  id: "taiex",
  name: "台股大盤",
  description: {
    zh: "查詢台股加權指數即時行情（Yahoo Finance，免 key）。",
    en: "Live TAIEX index quote (Yahoo Finance, no key).",
    ja: "加権指数のリアルタイム相場（Yahoo Finance、キー不要）。",
  },
  usage: {
    zh: "大盤",
    en: "taiex",
    ja: "大盤",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "大盤",
  triggerAliases: ["加權指數", "台股", "taiex", "指數"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 5 分鐘；盤中建議填 1m" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await fetchChart("^TWII", "1d");
      return [{ name: "Yahoo Finance", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "Yahoo Finance", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 5);
    try {
      let quote = readCache<IndexQuote>(CACHE_NAME, ttlMs);
      if (!quote) {
        const { meta } = await fetchChart("^TWII", "1d");
        const q = toQuote("^TWII", meta);
        if (!q) throw new Error("查無大盤資料");
        quote = q;
        writeCache(CACHE_NAME, quote);
      }
      const arrow = quote.change > 0 ? "▲" : quote.change < 0 ? "▼" : "＝";
      const sign = quote.change >= 0 ? "+" : "";
      const range = quote.high !== undefined && quote.low !== undefined
        ? `\n高 ${fmt(quote.high)} · 低 ${fmt(quote.low)}`
        : "";
      logger.info("大盤查詢", { price: quote.price });
      await ctx.reply(
        `台股加權指數\n${fmt(quote.price)} ${arrow} ${sign}${fmt(Math.abs(quote.change))} (${sign}${Math.abs(quote.pct).toFixed(2)}%)\n昨收 ${fmt(quote.prev)}${range}`,
      );
    } catch (error) {
      logger.error("大盤查詢失敗", { error: String(error) });
      await ctx.reply("大盤資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default taiexSkill;
