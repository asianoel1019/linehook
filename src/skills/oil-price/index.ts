import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition } from "../types.js";

const SOURCE = "https://vipmbr.cpc.com.tw/openData/MainProdListPrice";
const CACHE_NAME = "oil-price";

interface RawPrice {
  類別名稱?: string;
  產品編號?: string;
  產品名稱?: string;
  包裝?: string;
  銷售對象?: string;
  計價單位?: string;
  參考牌價_含稅?: number;
  營業稅_稅率?: string;
}

interface OilPrice {
  name: string;
  price: number;
  unit: string;
  date: string;
}

function formatRocDate(value: string): string {
  // 民國 YYMMDD（例如 1150928）
  const m = /^(\d{3})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return value;
  return `${Number(m[1]) + 1911}/${m[2]}/${m[3]}`;
}

async function getPrices(ttlMs: number): Promise<OilPrice[]> {
  const cached = readCache<OilPrice[]>(CACHE_NAME, ttlMs);
  if (cached && cached.length > 0) return cached;

  const res = await fetch(SOURCE, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" } });
  if (!res.ok) throw new Error(`油價來源失敗（HTTP ${res.status}）`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;

  const prices: OilPrice[] = [];
  for (const item of raw) {
    const rec = item as Record<string, unknown>;
    const get = (needle: string): string => {
      for (const [k, v] of Object.entries(rec)) if (k.includes(needle)) return String(v ?? "");
      return "";
    };
    const name = get("產品名稱") || get("名稱");
    const priceStr = get("參考牌價") || get("牌價");
    const price = Number(priceStr);
    const unit = get("計價單位") || "元/公升";
    if (!name || !Number.isFinite(price)) continue;
    // 只取零售汽柴油（元/公升），排除批售/海運（公秉）等
    if (!/汽油|柴油/.test(name)) continue;
    if (/海運|批售|燃料油|天然氣|瓦斯|航空/.test(name)) continue;
    if (!/公升/.test(unit)) continue;
    prices.push({
      name: name.replace(/無鉛汽油/, "無鉛"),
      price,
      unit: unit.replace(/\s+/g, ""),
      date: formatRocDate(get("牌價生效日期") || get("生效")),
    });
  }

  if (prices.length === 0) throw new Error("無法解析油價資料");
  writeCache(CACHE_NAME, prices);
  return prices;
}

const oilSkill: SkillDefinition = {
  id: "oil-price",
  name: "油價",
  description: {
    zh: "查詢中油汽柴油牌價（每週更新）。",
    en: "CPC gasoline/diesel prices (weekly).",
    ja: "中油のガソリン・軽油価格（毎週更新）。",
  },
  usage: {
    zh: "油價",
    en: "oil price",
    ja: "油価",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "油價",
  triggerAliases: ["汽油", "中油", "油品", "柴油"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；油價每週更新，可設 6h 或 24h" },
  ],
  async health() {
    try {
      const res = await fetch(SOURCE, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" } });
      return [{ name: "中油開放資料", ok: res.ok, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "中油開放資料", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    try {
      const prices = await getPrices(ttlMs);
      const lines = prices.map((p) => `${p.name}：${p.price.toFixed(1)} ${p.unit}`);
      const date = prices.find((p) => p.date)?.date;
      await ctx.reply(`中油油價${date ? `（${date}）` : ""}：\n${lines.join("\n")}`);
      logger.info("油價查詢", { count: prices.length });
    } catch (error) {
      logger.error("油價查詢失敗", { error: String(error) });
      await ctx.reply("油價來源目前無法使用，請稍後再試。");
    }
  },
};

export default oilSkill;
