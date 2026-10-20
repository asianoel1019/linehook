import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchJson as netFetchJson } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";

export interface YahooMeta {
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

/**
 * 台股中文名 → Yahoo 代碼（含 .TW 上市 / .TWO 上櫃）。
 * 每條都經過程式化校驗（TWSE 官方名單＋Yahoo 實際可查）；上櫃靠後綴區分，
 * Yahoo 查無的一律不收（例：已下市的新光金 2888、京城銀 2809 不在表內）。
 */
const NAME_MAP: Record<string, string> = {
  台積電: "2330.TW",
  台積: "2330.TW",
  TSMC: "2330.TW",
  聯電: "2303.TW",
  聯發科: "2454.TW",
  聯發: "2454.TW",
  日月光投控: "3711.TW",
  日月光: "3711.TW",
  瑞昱: "2379.TW",
  聯詠: "3034.TW",
  大立光: "3008.TW",
  玉晶光: "3406.TW",
  台達電: "2308.TW",
  光寶科: "2301.TW",
  國巨: "2327.TW",
  華新科: "2492.TW",
  鴻海: "2317.TW",
  廣達: "2382.TW",
  緯創: "3231.TW",
  緯穎: "6669.TW",
  仁寶: "2324.TW",
  和碩: "4938.TW",
  技嘉: "2376.TW",
  微星: "2377.TW",
  華碩: "2357.TW",
  宏碁: "2353.TW",
  英業達: "2356.TW",
  漢唐: "2404.TW",
  京元電: "2449.TW",
  欣銓: "3264.TWO",
  頎邦: "6147.TWO",
  欣興: "3037.TW",
  南電: "8046.TW",
  景碩: "3189.TW",
  楠梓電: "2316.TW",
  華通: "2313.TW",
  金像電: "2368.TW",
  燿華: "2367.TW",
  泰鼎: "4927.TW",
  臻鼎: "4958.TW",
  台光電: "2383.TW",
  台燿: "6274.TWO",
  聯茂: "6213.TW",
  奇鋐: "3017.TW",
  雙鴻: "3324.TWO",
  健策: "3653.TW",
  嘉澤: "3533.TW",
  川湖: "2059.TW",
  力積電: "6770.TW",
  世界: "5347.TWO",
  世界先進: "5347.TWO",
  群聯: "8299.TWO",
  力旺: "3529.TWO",
  義隆: "2458.TW",
  智原: "3035.TW",
  華邦電: "2344.TW",
  旺宏: "2337.TW",
  南亞科: "2408.TW",
  穩懋: "3105.TWO",
  全新: "2455.TW",
  宏達電: "2498.TW",
  鈊象: "3293.TWO",
  創意: "3443.TW",
  世芯: "3661.TW",
  祥碩: "5269.TW",
  譜瑞: "4966.TWO",
  信驊: "5274.TWO",
  矽力: "6415.TW",
  新唐: "4919.TW",
  佳能: "2374.TW",
  亞光: "3019.TW",
  創見: "2451.TW",
  威剛: "3260.TWO",
  M31: "6643.TWO",
  晶心科: "6533.TW",
  元太: "8069.TWO",
  家登: "3680.TWO",
  億光: "2393.TW",
  上銀: "2049.TW",
  所羅門: "2359.TW",
  中美晶: "5483.TWO",
  十銓: "4967.TW",
  原相: "3227.TWO",
  晶宏: "3141.TWO",
  創惟: "6104.TWO",
  愛普: "6531.TW",
  宏捷科: "8086.TWO",
  台特化: "4772.TWO",
  藥華藥: "6446.TW",
  視陽: "6782.TW",
  全家: "5903.TWO",
  台泥: "1101.TW",
  亞泥: "1102.TW",
  統一: "1216.TW",
  統一超: "2912.TW",
  台塑: "1301.TW",
  南亞: "1303.TW",
  台化: "1326.TW",
  台塑化: "6505.TW",
  遠東新: "1402.TW",
  儒鴻: "1476.TW",
  聚陽: "1477.TW",
  寶成: "9904.TW",
  豐泰: "9910.TW",
  巨大: "9921.TW",
  美利達: "9914.TW",
  中鋼: "2002.TW",
  士電: "1503.TW",
  中興電: "1513.TW",
  華城: "1519.TW",
  大同: "2371.TW",
  東元: "1504.TW",
  富邦金: "2881.TW",
  國泰金: "2882.TW",
  國泰: "2882.TW",
  中信金: "2891.TW",
  中信: "2891.TW",
  玉山金: "2884.TW",
  玉山: "2884.TW",
  元大金: "2885.TW",
  元大: "2885.TW",
  兆豐金: "2886.TW",
  兆豐: "2886.TW",
  第一金: "2892.TW",
  合庫金: "5880.TW",
  合庫: "5880.TW",
  華南金: "2880.TW",
  華南: "2880.TW",
  永豐金: "2890.TW",
  永豐: "2890.TW",
  台新金: "2887.TW",
  台新新光金: "2887.TW",
  凱基金: "2883.TW",
  開發金: "2883.TW",
  彰銀: "2801.TW",
  上海商銀: "5876.TW",
  台企銀: "2834.TW",
  中租: "5871.TW",
  台中銀: "2812.TW",
  裕融: "9941.TW",
  和潤: "6592.TW",
  長榮: "2603.TW",
  長榮海運: "2603.TW",
  陽明: "2609.TW",
  萬海: "2615.TW",
  新興: "2605.TW",
  裕民: "2606.TW",
  華航: "2610.TW",
  中華航空: "2610.TW",
  長榮航: "2618.TW",
  長榮航空: "2618.TW",
  星宇: "2646.TW",
  星宇航空: "2646.TW",
  虎航: "6757.TW",
  台灣虎航: "6757.TW",
  漢翔: "2634.TW",
  雷虎: "8033.TW",
  龍德造船: "6753.TW",
  中華電: "2412.TW",
  中華電信: "2412.TW",
  台灣大: "3045.TW",
  遠傳: "4904.TW",
  王品: "2727.TW",
  瓦城: "2729.TWO",
  豆府: "2752.TWO",
  八方雲集: "2753.TWO",
  雄獅: "2731.TW",
  築間: "7723.TWO",
  路易莎: "2758.TWO",
  誠品: "2926.TWO",
  寶雅: "5904.TWO",
  富邦媒: "8454.TW",
  網家: "8044.TWO",
  裕隆: "2201.TW",
  和泰車: "2207.TW",
  中華汽車: "2204.TW",
  三陽: "2206.TW",
  喬山: "1736.TW",
  飛宏: "2457.TW",
  上緯投控: "3708.TW",
  世紀鋼: "9958.TW",
  大江: "8436.TWO",
  葡萄王: "1707.TW",
  美食: "2723.TW",
  數字: "5287.TWO",
  伊雲谷: "6689.TW",
  正新: "2105.TW",
  保瑞: "6472.TW",
  大樹: "6469.TWO",
  晶碩: "6491.TW",
  高力: "8996.TW",
};

/** 上櫃代號集合（直接打代號時決定 .TWO 後綴）。 */
export const OTC_CODES: Set<string> = new Set(
  Object.values(NAME_MAP)
    .filter((s) => s.endsWith(".TWO"))
    .map((s) => s.slice(0, -4)),
);

const CLEAN_RE =
  /請幫忙|請幫|幫忙|查詢|查一下|股價|股票|行情|現在|報價|價格|多少錢|多少|值得|走勢|漲跌|如何|怎麼|嗎|值|漲|跌|的/g;

export function resolveSymbol(text: string): string {
  const norm = text.replace(/臺/g, "台");
  const cleaned = norm.replace(CLEAN_RE, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (NAME_MAP[t]) return NAME_MAP[t];
    const up = t.toUpperCase();
    if (/^\d{4,6}[A-Z]?$/.test(up)) {
      const code = up.replace(/[A-Z]$/, "");
      return OTC_CODES.has(code) ? `${code}.TWO` : `${up}.TW`;
    }
    if (/^[\^A-Z][A-Z0-9.\-]{0,9}$/.test(up)) return up.includes(".") ? up : up;
  }
  // 子字串後援（「我想問台積電」；長名優先避免短別名搶先）
  const keys = Object.keys(NAME_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (norm.includes(k)) return NAME_MAP[k];
  }
  return "";
}

const TWSE_LIST_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const TWSE_LIST_TTL = 7 * 24 * 3600_000;
const TWSE_CACHE = "stock-twse-list";

interface TwseEntry {
  code: string;
  short: string;
  name: string;
}

async function loadTwseList(): Promise<TwseEntry[]> {
  const cached = readCache<TwseEntry[]>(TWSE_CACHE, TWSE_LIST_TTL);
  if (cached && cached.length > 0) return cached;
  const data = await netFetchJson<Array<Record<string, string>>>(TWSE_LIST_URL, undefined, {
    timeoutMs: 20_000,
    maxBytes: 4 * 1024 * 1024,
  });
  const list = data
    .map((d) => ({
      code: (d["公司代號"] ?? "").trim(),
      short: (d["公司簡稱"] ?? "").trim(),
      name: (d["公司名稱"] ?? "").trim(),
    }))
    .filter((d) => /^\d{4}$/.test(d.code) && d.short);
  if (list.length === 0) throw new Error("TWSE 名單為空");
  writeCache(TWSE_CACHE, list);
  return list;
}

/**
 * 活路：靜態表查無時，對 TWSE 上市全名單比對（冷門公司名如「高力」）。
 * 單一 token 精確命中簡稱才回；多個候選一律放棄（寧可回用法也不報錯價）。
 * 上櫃冷門名不在此表，仍須打代號。
 */
export async function resolveSymbolLive(text: string): Promise<string> {
  const norm = text.replace(/臺/g, "台");
  const tokens = norm
    .replace(CLEAN_RE, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  let list: TwseEntry[];
  try {
    list = await loadTwseList();
  } catch (error) {
    logger.warn("TWSE 名單載入失敗", { error: error instanceof Error ? error.message : String(error) });
    return "";
  }
  const normShort = (s: string): string => s.replace(/臺/g, "台");
  for (const t of tokens) {
    const exact = list.find((d) => normShort(d.short) === t || normShort(d.name) === t);
    if (exact) return `${exact.code}.TW`;
  }
  for (const t of tokens) {
    const cands = list.filter((d) => {
      const s = normShort(d.short);
      return s.includes(t) || t.includes(s);
    });
    if (cands.length === 1) return `${cands[0].code}.TW`;
  }
  return "";
}

export async function fetchChart(symbol: string, range: string): Promise<{ meta: YahooMeta; closes: number[] }> {
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
    zh: "查詢即時股價（Yahoo Finance；上市櫃公司名或代號皆可，如台積電、群聯、全家）。",
    en: "Real-time stock quotes (Yahoo Finance; TWSE/OTC names or codes).",
    ja: "リアルタイム株価（Yahoo Finance）。",
  },
  usage: {
    zh: "股價 2330、股價 台積電、股價 群聯、股價 全家",
    en: "stock 2330",
    ja: "株価 2330",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "股價",
  // 公司名也參與無前綴意圖計分（「台積電股價」→ 台積電3＋股價2 達標；單獨「台積電」3 分不觸發）。
  naturalKeywords: ["股價多少", "股價如何", "收盤價", "股價", ...Object.keys(NAME_MAP)],
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
    let symbol = resolveSymbol(ctx.args);
    if (!symbol) {
      // 靜態表查無：走 TWSE 全名單活路（冷門公司名）
      symbol = await resolveSymbolLive(ctx.args);
    }
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
