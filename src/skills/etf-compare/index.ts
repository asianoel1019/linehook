import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
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
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: YahooMeta;
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
}

interface EtfDetail {
  name: string;
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  prevClose: number;
  currency: string;
  yield?: number;
  yieldPct?: number;
  expenseRatio?: number;
  netAssets?: number;
  ytdReturn?: number;
  threeYearReturn?: number;
  fiveYearReturn?: number;
}

export function resolveEtfSymbol(text: string): string[] {
  const cleaned = text.replace(/請幫忙|請幫|幫忙|比較|比一比|查一下|ETF|etf|的|和|與|vs|VS/gi, " ");
  const symbols: string[] = [];
  for (const raw of cleaned.split(/[\s,、]+/)) {
    const t = raw.trim().toUpperCase();
    if (!t) continue;
    if (/^\d{4,6}$/.test(t)) {
      symbols.push(`${t}.TW`);
    } else if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) && !/^(THE|AND|FOR|WITH|比|的|和)$/.test(t)) {
      symbols.push(t);
    }
    if (symbols.length >= 5) break;
  }
  return [...new Set(symbols)];
}

async function fetchEtfData(symbol: string, ttlMs: number): Promise<EtfDetail> {
  const cacheKey = `etf-${symbol}`;
  const cached = readCache<EtfDetail>(cacheKey, ttlMs);
  if (cached) return cached;

  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const chartData = await netFetchJson<YahooChart>(chartUrl, {
    headers: { "User-Agent": UA },
  }, { timeoutMs: 15_000, maxBytes: 512 * 1024 });

  const result = chartData.chart?.result?.[0];
  if (!result?.meta) throw new Error(chartData.chart?.error?.description ?? `查無 ${symbol}`);
  const meta = result.meta;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
  const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price - prev;
  const changePct = prev !== 0 ? (change / prev) * 100 : 0;

  const detail: EtfDetail = {
    name: meta.longName || meta.shortName || symbol,
    symbol: meta.symbol || symbol,
    price,
    change,
    changePct,
    prevClose: prev,
    currency: meta.currency || "",
  };

  // Try to get ETF-specific data from quoteSummary
  try {
    const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,summaryDetail,fundProfile`;
    const summary = await netFetchJson<{ quoteSummary?: { result?: Array<Record<string, Record<string, { raw?: number; fmt?: string }>>> } }>(
      summaryUrl,
      { headers: { "User-Agent": UA } },
      { timeoutMs: 10_000, maxBytes: 256 * 1024 },
    );
    const r = summary.quoteSummary?.result?.[0];
    if (r) {
      const stats = r.defaultKeyStatistics ?? {};
      const summaryDetail = r.summaryDetail ?? {};
      const profile = r.fundProfile ?? {};
      detail.yield = summaryDetail.yield?.raw;
      detail.yieldPct = summaryDetail.yield?.raw !== undefined ? summaryDetail.yield.raw * 100 : undefined;
      detail.expenseRatio = profile.annualReportExpenseRatio?.raw ?? stats.annualReportExpenseRatio?.raw;
      detail.netAssets = stats.totalAssets?.raw ?? profile.totalAssets?.raw;
      detail.ytdReturn = stats.ytdReturn?.raw;
      detail.threeYearReturn = stats.threeYearReturn?.raw;
      detail.fiveYearReturn = stats.fiveYearReturn?.raw;
    }
  } catch {
    // ETF detail unavailable — use basic price data only
  }

  writeCache(cacheKey, detail);
  return detail;
}

function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtAssets(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}兆`;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}億`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}萬`;
  return fmt(n, 0);
}

function renderSingle(e: EtfDetail): string {
  const arrow = e.change > 0 ? "▲" : e.change < 0 ? "▼" : "＝";
  const lines = [
    `${e.name}（${e.symbol}）`,
    `${fmt(e.price)} ${e.currency}　${arrow} ${fmt(Math.abs(e.change))} (${fmtPct(e.changePct)})`,
  ];
  const extras: string[] = [];
  if (e.yieldPct !== undefined) extras.push(`殖利率 ${e.yieldPct.toFixed(2)}%`);
  if (e.expenseRatio !== undefined) extras.push(`費用率 ${(e.expenseRatio * 100).toFixed(2)}%`);
  if (e.netAssets !== undefined) extras.push(`規模 ${fmtAssets(e.netAssets)}`);
  if (extras.length) lines.push(extras.join(" · "));
  const returns: string[] = [];
  if (e.ytdReturn !== undefined) returns.push(`YTD ${fmtPct(e.ytdReturn * 100)}`);
  if (e.threeYearReturn !== undefined) returns.push(`3Y ${fmtPct(e.threeYearReturn * 100)}`);
  if (e.fiveYearReturn !== undefined) returns.push(`5Y ${fmtPct(e.fiveYearReturn * 100)}`);
  if (returns.length) lines.push(returns.join(" · "));
  return lines.join("\n");
}

function renderComparison(items: EtfDetail[]): string {
  const lines: string[] = [];
  const sorted = [...items].sort((a, b) => b.changePct - a.changePct);
  for (const e of sorted) {
    const arrow = e.change > 0 ? "▲" : e.change < 0 ? "▼" : "＝";
    lines.push(`${e.name}（${e.symbol}）`);
    lines.push(`  ${fmt(e.price)} ${e.currency}　${arrow} ${fmtPct(e.changePct)}`);
    const extras: string[] = [];
    if (e.yieldPct !== undefined) extras.push(`殖利率 ${e.yieldPct.toFixed(2)}%`);
    if (e.expenseRatio !== undefined) extras.push(`費用率 ${(e.expenseRatio * 100).toFixed(2)}%`);
    if (e.netAssets !== undefined) extras.push(`規模 ${fmtAssets(e.netAssets)}`);
    if (extras.length) lines.push(`  ${extras.join(" · ")}`);
    lines.push("");
  }
  const best = sorted[0];
  if (best) lines.push(`📈 今日最佳：${best.name} ${fmtPct(best.changePct)}`);
  return lines.join("\n");
}

const etfCompareSkill: SkillDefinition = {
  id: "etf-compare",
  name: "ETF 比較",
  description: {
    zh: "查詢與比較多檔 ETF 的價格、殖利率、費用率。",
    en: "Compare multiple ETFs: price, yield, expense ratio.",
    ja: "複数のETFの価格・利回り・経費率を比較します。",
  },
  usage: {
    zh: "ETF 0050 0056 00878\nETF SPY QQQ",
    en: "etf 0050 0056 00878\netf SPY QQQ",
    ja: "ETF 0050 0056 00878",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "ETF",
  triggerAliases: ["etf", "etf比較", "基金比較"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 30 分鐘；可填 10m、1h", default: "30" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await fetchEtfData("0050.TW", 60_000);
      return [{ name: "Yahoo Finance", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "Yahoo Finance", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const symbols = resolveEtfSymbol(ctx.args);
    if (symbols.length === 0) {
      await ctx.reply("請指定 ETF 代號，例如：ETF 0050 0056 00878（美股：ETF SPY QQQ）");
      return;
    }

    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);
    const results: EtfDetail[] = [];
    for (const sym of symbols) {
      try {
        const detail = await fetchEtfData(sym, ttlMs);
        results.push(detail);
      } catch (error) {
        logger.warn("ETF 查詢失敗", { symbol: sym, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (results.length === 0) {
      await ctx.reply("查不到任何 ETF 資料，請確認代號。");
      return;
    }

    if (results.length === 1) {
      logger.info("ETF 查詢", { symbol: results[0].symbol });
      await ctx.reply(renderSingle(results[0]));
      return;
    }

    logger.info("ETF 比較", { symbols: results.map((r) => r.symbol), count: results.length });
    await ctx.reply(renderComparison(results));
  },
};

export default etfCompareSkill;
