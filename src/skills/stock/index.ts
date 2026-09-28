import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (compatible; LineHook/1.0)";

interface YahooMeta {
  currency?: string;
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: YahooMeta;
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
}

function resolveSymbol(text: string): string {
  const cleaned = text.replace(/請幫忙|請幫|幫忙|查詢|查一下|股價|股票|行情|現在|報價|價格|的/g, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.trim().toUpperCase();
    if (!t) continue;
    if (/^\d{4,6}[A-Z]?$/.test(t)) return `${t}.TW`;
    if (/^[\^A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return t.includes(".") ? t : t;
  }
  return "";
}

async function fetchChart(symbol: string, range: string): Promise<{ meta: YahooMeta; closes: number[] }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as YahooChart;
  const result = data.chart?.result?.[0];
  if (!result || !result.meta) throw new Error(data.chart?.error?.description ?? "查無資料");
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
  return { meta: result.meta, closes };
}

function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const stockSkill: SkillDefinition = {
  id: "stock",
  name: "股價",
  description: {
    zh: "查詢即時股價（Yahoo Finance）。",
    en: "Real-time stock quotes (Yahoo Finance).",
    ja: "リアルタイム株価（Yahoo Finance）。",
  },
  usage: {
    zh: "股價 2330",
    en: "stock 2330",
    ja: "株価 2330",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "股價",
  triggerAliases: ["股票", "stock", "報價", "行情"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 5 分鐘；盤中建議填 1m" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await fetchChart("2330.TW", "1d");
      return [{ name: "Yahoo Finance", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "Yahoo Finance", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const symbol = resolveSymbol(ctx.args);
    if (!symbol) {
      await ctx.reply("請指定股票代號，例如：阿寶請幫忙 股價 2330（美股：股價 AAPL）");
      return;
    }
    const ttlMs = parseTtl(ctx.config.cacheTtl, 5);
    const cacheKey = `stock-${symbol}`;
    let reading = readCache<{ meta: YahooMeta; closes: number[] }>(cacheKey, ttlMs);
    if (!reading) {
      try {
        reading = await fetchChart(symbol, "1mo");
      } catch (error) {
        logger.warn("股價查詢失敗", { symbol, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply(`查不到「${symbol}」的股價，請確認代號。`);
        return;
      }
      writeCache(cacheKey, reading);
    }
    const { meta, closes } = reading;
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const digits = price !== undefined && price < 100 ? 2 : 2;
    const name = meta.longName || meta.shortName || symbol;
    const cur = meta.currency || "";

    let changeLine = "";
    if (price !== undefined && prev !== undefined && prev !== 0) {
      const diff = price - prev;
      const pct = (diff / prev) * 100;
      const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "＝";
      changeLine = `\n${arrow} ${fmt(Math.abs(diff), digits)} (${diff >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(2)}%)　昨收 ${fmt(prev, digits)}`;
    }

    const range: string[] = [];
    if (meta.regularMarketDayHigh !== undefined) range.push(`高 ${fmt(meta.regularMarketDayHigh, digits)}`);
    if (meta.regularMarketDayLow !== undefined) range.push(`低 ${fmt(meta.regularMarketDayLow, digits)}`);
    const vol = meta.regularMarketVolume !== undefined ? `\n成交量 ${Math.round(meta.regularMarketVolume / 1000).toLocaleString("en-US")} 張` : "";

    await ctx.reply(`${name}（${meta.symbol ?? symbol}）\n${fmt(price, digits)} ${cur}${changeLine}${range.length ? `\n${range.join(" · ")}` : ""}${vol}`);
  },
};

export default stockSkill;
