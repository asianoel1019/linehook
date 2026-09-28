import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const MOA_URL = "https://data.moa.gov.tw/api/v1/AgriProductsTransType/";

interface MoaRow {
  TransDate?: string;
  TCType?: string;
  CropCode?: string;
  CropName?: string;
  MarketName?: string;
  Upper_Price?: string | number;
  Middle_Price?: string | number;
  Lower_Price?: string | number;
  Avg_Price?: string | number;
  Trans_Quantity?: string | number;
}

interface MoaResponse {
  RS?: string;
  Data?: MoaRow[];
  Next?: boolean;
}

function num(v: string | number | undefined): number {
  if (v === undefined || v === null) return NaN;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function parseCrop(text: string): string {
  return text
    .replace(/請幫忙|請幫|幫忙|查詢|查一下|查個|菜價|蔬果|菜市場|市場|批發|行情|價格|均價|多少|的/g, " ")
    .replace(/(臺北|台北|臺中|台中|高雄|三重|板橋|桃園|新竹|嘉義|臺南|台南|花蓮|宜蘭|彰化|員林|臺東|台東|屏東|中壢|臺北二|台北二)[一二]?/g, " ")
    .trim();
}

function ymd(d: Date): string {
  const p = (n: number) => ("0" + n).slice(-2);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MARKETS = ["臺北一", "臺北二", "三重", "板橋", "桃園", "臺中", "高雄", "臺南", "嘉義", "彰化", "員林", "花蓮", "宜蘭", "臺東"];

const cropSkill: SkillDefinition = {
  id: "crop-price",
  name: "菜價",
  description: {
    zh: "查詢農產品批發價（農業部開放資料，需免費 api_key）。",
    en: "Wholesale crop prices (MOA open data, free api_key).",
    ja: "農産物の卸売価格（農業部オープンデータ、無料 api_key）。",
  },
  usage: {
    zh: "菜價 高麗菜",
    en: "crop price cabbage",
    ja: "野菜価格 キャベツ",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "菜價",
  triggerAliases: ["蔬果價", "菜", "農產", "批發價"],
  fields: [
    { key: "moaKey", label: { zh: "農業部 API Key", en: "MOA API Key", ja: "農業部 API キー" }, secret: true, hint: "至 https://data.moa.gov.tw 免費註冊取得" },
    { key: "market", label: { zh: "批發市場", en: "Wholesale market", ja: "卸売市場" }, type: "select", options: MARKETS.map((m) => ({ value: m, label: m })), hint: "預設 臺北一" },
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 6 小時；可填 30m、1d" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${MOA_URL}?page=1`, {
        headers: { "User-Agent": "LineHook/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      return [{ name: "農業部資料", ok: res.status < 500, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "農業部資料", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const key = (ctx.config.moaKey || "").trim();
    if (!key) {
      await ctx.reply("菜價技能尚未設定農業部 API Key，請到設定頁填寫（可至 data.moa.gov.tw 免費註冊）。");
      return;
    }
    const crop = parseCrop(ctx.args);
    if (!crop) {
      await ctx.reply("請指定農產品名稱，例如：阿寶請幫忙 菜價 高麗菜");
      return;
    }
    const market = (ctx.config.market || "臺北一").trim();
    const ttlMs = parseTtl(ctx.config.cacheTtl, 360);
    const cacheKey = `crop-${market}-${crop}`;

    let rows = readCache<MoaRow[]>(cacheKey, ttlMs);
    if (!rows) {
      const now = nowInTz();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14);
      const params = new URLSearchParams({
        Start_time: ymd(start),
        End_time: ymd(now),
        MarketName: market,
        CropName: crop,
        api_key: key,
        page: "1",
      });
      try {
        const res = await fetch(`${MOA_URL}?${params.toString()}`, {
          headers: { "User-Agent": "LineHook/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MoaResponse;
        rows = Array.isArray(data.Data) ? data.Data : [];
      } catch (error) {
        logger.warn("菜價查詢失敗", { crop, market, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("農業部資料來源目前無法使用，請稍後再試。");
        return;
      }
      writeCache(cacheKey, rows);
    }

    if (rows.length === 0) {
      await ctx.reply(`在「${market}」查不到「${crop}」近兩週的批發價。可換市場或名稱再試（如：菜價 臺北二 高麗菜）。`);
      return;
    }

    const latestDate = rows
      .map((r) => String(r.TransDate ?? ""))
      .filter(Boolean)
      .sort()
      .pop();
    const day = rows.filter((r) => String(r.TransDate ?? "") === latestDate);

    const avg = day.map((r) => num(r.Avg_Price)).filter((n) => Number.isFinite(n));
    const mid = day.map((r) => num(r.Middle_Price)).filter((n) => Number.isFinite(n));
    const upper = day.map((r) => num(r.Upper_Price)).filter((n) => Number.isFinite(n));
    const lower = day.map((r) => num(r.Lower_Price)).filter((n) => Number.isFinite(n));
    const qty = day.map((r) => num(r.Trans_Quantity)).filter((n) => Number.isFinite(n));
    const mean = (a: number[]) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : NaN);

    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
    const name = day[0]?.CropName || crop;
    const dateStr = latestDate ? latestDate.slice(5) : "";
    const qtyLine = qty.length ? `\n交易量 ${Math.round(mean(qty)).toLocaleString("en-US")} 公斤` : "";

    await ctx.reply(
      `${name}（${market} 批發市場）\n${dateStr} 均價 ${f(mean(avg))} 元/公斤\n` +
      `上價 ${f(mean(upper))} · 中價 ${f(mean(mid))} · 下價 ${f(mean(lower))}${qtyLine}`,
    );
  },
};

export default cropSkill;
