import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

interface Source {
  name: string;
  url: string;
}

const SOURCES: Source[] = [
  { name: "好康情報誌", url: "https://info.talk.tw/mcdonalds-coupons" },
  { name: "好康情報誌（優惠券）", url: "https://info.talk.tw/2026mcdonalds-coupon" },
];

export interface Promo {
  name: string;
  offer: string;
  period: string;
  price?: number;
}

const CACHE_NAME = "mcdonald-promos";
const NOISE = /連結前往購買|點我|詳情|立即前往|^\s*$/;

function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#0*32;|&#8211;|–|—/g, " ").replace(/\s+/g, " ").trim())
    .filter((c) => c && !NOISE.test(c));
}

/** 解析優惠表格列；回傳結構化品項。 */
export function parseTableItems(html: string): Promo[] {
  const out: Promo[] = [];
  for (const tb of html.matchAll(/<table[\s\S]*?>([\s\S]*?)<\/table>/gi)) {
    for (const row of tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = cellsOf(row[1]);
      if (cells.length < 2) continue;
      if (/餐點品項|品項|優惠內容|特惠價/.test(cells[0]) && cells.length <= 4) continue; // 表頭
      const name = cells[0].slice(0, 40);
      const rest = cells.slice(1).join("／").slice(0, 120);
      if (!name || !rest) continue;
      const priceMatch = rest.match(/\$?\s*(\d{2,4})\s*元/);
      const periodMatch = rest.match(/(即日起.{0,12}|至\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}開賣|^\d+月)/);
      out.push({
        name,
        offer: rest,
        period: periodMatch ? periodMatch[0] : "",
        price: priceMatch ? Number(priceMatch[1]) : undefined,
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.name}|${p.offer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 預算配對：價格在目標 ±30% 內。 */
export function matchBudget(promos: Promo[], target: number): Promo[] {
  const low = target * 0.7;
  const high = target * 1.3;
  return promos
    .filter((p) => p.price !== undefined && p.price >= low && p.price <= high)
    .sort((a, b) => Math.abs((a.price ?? 0) - target) - Math.abs((b.price ?? 0) - target));
}

async function loadPromos(ttlMs: number): Promise<{ promos: Promo[]; source: string }> {
  const cached = readCache<{ promos: Promo[]; source: string }>(CACHE_NAME, ttlMs);
  if (cached && Array.isArray(cached.promos) && cached.promos.length > 0) return cached;
  let lastError = "";
  for (const source of SOURCES) {
    try {
      const html = await netFetchText(source.url, undefined, {
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
      });
      const promos = parseTableItems(html);
      if (promos.length === 0) throw new Error("解析不到優惠");
      const result = { promos, source: source.name };
      writeCache(CACHE_NAME, result);
      logger.info("麥當勞優惠已載入", { source: source.name, count: promos.length });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn("麥當勞優惠來源失效，改用備援", { source: source.name, error: lastError });
    }
  }
  throw new Error(`所有來源皆失效：${lastError}`);
}

function formatPromo(p: Promo): string {
  const periodLine = p.period && !p.offer.includes(p.period) ? `\n  ${p.period}` : "";
  return `・${p.name}\n  ${p.offer}${periodLine}`;
}

const mcdonaldSkill: SkillDefinition = {
  id: "mcdonald",
  name: "麥當勞優惠",
  description: {
    zh: "查詢麥當勞當期優惠（APP 優惠券、買一送一、甜心卡等）。",
    en: "Current McDonald's Taiwan promotions.",
    ja: "マクドナルド台湾の最新キャンペーン。",
  },
  usage: {
    zh: "麥當勞 買一送一",
    en: "mcdonald coupon",
    ja: "麥當勞 coupon",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "麥當勞",
  triggerAliases: ["麥當勞優惠", "mcdonald", "mcd", "麥記"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 6 小時；優惠不常變，可設 12h、1d" },
  ],
  async health(): Promise<SkillHealth[]> {
    const results = await Promise.all(
      SOURCES.map(async (s): Promise<SkillHealth> => {
        try {
          const res = await fetch(s.url, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" },
            signal: AbortSignal.timeout(15_000),
          });
          return { name: s.name, ok: res.ok, detail: `HTTP ${res.status}` };
        } catch {
          return { name: s.name, ok: false, detail: "連線失敗" };
        }
      }),
    );
    return results;
  },
  async run(ctx: SkillContext): Promise<void> {
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|麥當勞|麥記|優惠|特價|活動|mcdonald|mcd|的/g, " ")
      .trim();
    const normNum = (s: string): string =>
      s.replace(/[一二三四五六七八九]/g, (c) => "一二三四五六七八九".indexOf(c) + 1 + "");
    const budgetMatch = keyword.match(/(\d{2,4})/);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 360);
    try {
      const { promos, source } = await loadPromos(ttlMs);
      let list = promos;
      let title = `麥當勞當期優惠（${source}）：`;
      if (budgetMatch) {
        const target = Number(budgetMatch[1]);
        const matched = matchBudget(promos, target);
        if (matched.length === 0) {
          await ctx.reply(`找不到 $${Math.round(target * 0.7)}～$${Math.round(target * 1.3)} 的麥當勞優惠。`);
          return;
        }
        list = matched.slice(0, 8);
        title = `麥當勞 $${Math.round(target * 0.7)}～$${Math.round(target * 1.3)} 的優惠：`;
      } else if (keyword) {
        const normKey = normNum(keyword);
        const filtered = promos.filter(
          (p) => p.name.includes(keyword) || p.offer.includes(keyword) || normNum(p.offer).includes(normKey),
        );
        if (filtered.length === 0) {
          await ctx.reply(`找不到「${keyword}」相關優惠。`);
          return;
        }
        list = filtered.slice(0, 8);
      } else {
        list = promos.slice(0, 8);
      }
      await ctx.reply(`${title}\n${list.map(formatPromo).join("\n")}`);
    } catch (error) {
      logger.error("麥當勞優惠查詢失敗", { error: String(error) });
      await ctx.reply("目前所有優惠資料來源皆無法使用，請稍後再試。");
    }
  },
};

export default mcdonaldSkill;
