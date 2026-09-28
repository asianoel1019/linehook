import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const USER_AGENT = "Mozilla/5.0 (compatible; LineHook/1.0)";
const CACHE_NAME = "burger-coupon";

interface Brand {
  id: string;
  name: string;
  aliases: string[];
  urls: string[];
}

const BRANDS: Brand[] = [
  {
    id: "bk",
    name: "漢堡王",
    aliases: ["漢堡王", "burgerking", "bk", "華堡"],
    urls: ["https://www.burgerking.com.tw/deals", "https://www.burgerking.com.tw/"],
  },
  {
    id: "mos",
    name: "摩斯漢堡",
    aliases: ["摩斯", "mos", "mosburger", "摩斯漢堡"],
    urls: ["https://www.mos.com.tw/news.aspx", "https://www.mos.com.tw/"],
  },
];

const health: Record<string, { ok: boolean; detail: string }> = {};

interface Deal {
  brand: string;
  title: string;
  price: string;
  detail: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/** 從頁面文字擷取含價格（$NN / NN元）的優惠片段。 */
function extractDeals(brand: Brand, html: string): Deal[] {
  const text = toText(html);
  const deals: Deal[] = [];
  const re = /([\u4e00-\u9fffA-Za-z0-9（）()、\s]{4,40}?)\s*(?:\$|＄|NT\$?)\s*(\d{2,4})/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(text))) {
    const title = m[1].trim().replace(/\s+/g, " ").slice(-30);
    const price = m[2];
    const key = `${title}|${price}`;
    if (seen.has(key) || title.length < 3) continue;
    seen.add(key);
    deals.push({ brand: brand.name, title, price, detail: "" });
    if (deals.length >= 20) break;
  }
  return deals;
}

async function getDeals(brand: Brand, ttlMs: number): Promise<Deal[]> {
  const cached = readCache<Deal[]>(`${CACHE_NAME}-${brand.id}`, ttlMs);
  if (cached && cached.length > 0) return cached;
  const collected: Deal[] = [];
  const seen = new Set<string>();
  for (const url of brand.urls) {
    try {
      const html = await fetchText(url);
      for (const d of extractDeals(brand, html)) {
        const key = `${d.title}|${d.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(d);
      }
    } catch {
      // try next url
    }
    if (collected.length > 0) break;
  }
  if (collected.length === 0) throw new Error("無法解析優惠");
  writeCache(`${CACHE_NAME}-${brand.id}`, collected);
  return collected;
}

function brandFrom(text: string): Brand | undefined {
  const lower = text.toLowerCase();
  return BRANDS.find((b) => b.aliases.some((a) => lower.includes(a.toLowerCase())));
}

function formatReply(brand: Brand, target: number | null, deals: Deal[]): string {
  let list = deals;
  if (target !== null) {
    const low = target * 0.7;
    const high = target * 1.3;
    list = deals
      .filter((d) => {
        const p = Number(d.price);
        return Number.isFinite(p) && p >= low && p <= high;
      })
      .sort((a, b) => Math.abs(Number(a.price) - target) - Math.abs(Number(b.price) - target));
  }
  list = list.slice(0, 8);
  if (list.length === 0) {
    return target !== null
      ? `找不到 ${brand.name} 約 ${target} 元（±30%）的優惠，可試其他價位。`
      : `${brand.name} 目前沒有可顯示的優惠。`;
  }
  const lines = list.map((d) => `$${d.price} ${d.title}`);
  return `${brand.name} 優惠（${deals.length} 筆，顯示前 ${list.length}）：\n${lines.join("\n")}`;
}

const burgerSkill: SkillDefinition = {
  id: "burger-coupon",
  name: "漢堡王 / 摩斯優惠",
  description: {
    zh: "查詢漢堡王、摩斯漢堡當期優惠。",
    en: "Burger King / MOS current deals.",
    ja: "バーガーキング・モスの最新お得情報。",
  },
  usage: {
    zh: "漢堡王 100",
    en: "burger 100",
    ja: "バーガーキング 100",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "漢堡王",
  triggerAliases: ["摩斯", "mos", "mosburger", "華堡", "burgerking"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；優惠不常變可設 6h、12h" },
  ],
  async health(): Promise<SkillHealth[]> {
    return Promise.all(
      BRANDS.map(async (b): Promise<SkillHealth> => {
        try {
          const res = await fetch(b.urls[0], { headers: { "User-Agent": USER_AGENT } });
          health[b.name] = { ok: res.ok, detail: `HTTP ${res.status}` };
          return { name: b.name, ok: res.ok, detail: `HTTP ${res.status}` };
        } catch {
          health[b.name] = { ok: false, detail: "連線失敗" };
          return { name: b.name, ok: false, detail: "連線失敗" };
        }
      }),
    );
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const brand = brandFrom(ctx.text) ?? brandFrom(ctx.args) ?? BRANDS[0];
    const priceMatch = ctx.args.match(/(\d{2,4})/);
    const target = priceMatch ? Number(priceMatch[1]) : null;

    try {
      const deals = await getDeals(brand, ttlMs);
      await ctx.reply(formatReply(brand, target, deals));
      logger.info("優惠查詢", { brand: brand.id, target, count: deals.length });
    } catch (error) {
      logger.error("優惠查詢失敗", { brand: brand.id, error: String(error) });
      await ctx.reply(`${brand.name} 優惠來源目前無法使用，請稍後再試。`);
    }
  },
};

export default burgerSkill;
