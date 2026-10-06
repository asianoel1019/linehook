import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";

interface ProductResult {
  source: string;
  title: string;
  price: number;
  url: string;
}

interface SourceConfig {
  name: string;
  searchUrl: (q: string) => string;
  parse: (html: string, baseUrl: string) => ProductResult[];
}

export function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractPrice(text: string): number | null {
  const cleaned = text.replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function yahooParse(html: string, baseUrl: string): ProductResult[] {
  const results: ProductResult[] = [];
  const blocks = html.split(/<li[^>]*class="[^"]*GridItem[^"]*"/i).slice(1);
  for (const block of blocks.slice(0, 10)) {
    const titleM = /<a[^>]*class="[^"]*ProductTitle[^"]*"[^>]*>([^<]+)<\/a>/i.exec(block)
      || /<h3[^>]*>([^<]+)<\/h3>/i.exec(block);
    const priceM = /NT\$?\s*([\d,]+)/i.exec(block) || /<em[^>]*>([\d,]+)<\/em>/i.exec(block);
    const linkM = /<a[^>]*href="(https:\/\/[^"]+)"/i.exec(block);
    if (titleM && priceM) {
      const price = extractPrice(priceM[1]);
      if (price) {
        results.push({
          source: "Yahoo購物",
          title: decode(titleM[1]),
          price,
          url: linkM ? linkM[1] : baseUrl,
        });
      }
    }
  }
  return results;
}

export function pchomeParse(html: string, baseUrl: string): ProductResult[] {
  const results: ProductResult[] = [];
  const blocks = html.split(/<li[^>]*class="[^"]*prod_item[^"]*"/i).slice(1);
  for (const block of blocks.slice(0, 10)) {
    const titleM = /<a[^>]*class="[^"]*prod_name[^"]*"[^>]*title="([^"]+)"/i.exec(block)
      || /<a[^>]*class="[^"]*prod_name[^"]*"[^>]*>([^<]+)<\/a>/i.exec(block);
    const priceM = /<b[^>]*class="[^"]*price[^"]*"[^>]*>([\d,]+)<\/b>/i.exec(block)
      || /NT\$?\s*([\d,]+)/i.exec(block);
    const linkM = /<a[^>]*href="(\/prod\/[^"]+)"/i.exec(block);
    if (titleM && priceM) {
      const price = extractPrice(priceM[1]);
      if (price) {
        const url = linkM ? `https://24h.pchome.com.tw${linkM[1]}` : baseUrl;
        results.push({
          source: "PChome 24h",
          title: decode(titleM[1]),
          price,
          url,
        });
      }
    }
  }
  return results;
}

const SOURCES: SourceConfig[] = [
  {
    name: "Yahoo購物",
    searchUrl: (q) => `https://tw.buy.yahoo.com/search/product?p=${encodeURIComponent(q)}`,
    parse: yahooParse,
  },
  {
    name: "PChome 24h",
    searchUrl: (q) => `https://24h.pchome.com.tw/search/?q=${encodeURIComponent(q)}`,
    parse: pchomeParse,
  },
];

export function fmtPrice(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

const priceCompareSkill: SkillDefinition = {
  id: "price-compare",
  name: "產品比價",
  description: {
    zh: "搜尋 Yahoo 購物與 PChome 24h 的商品價格，快速比價。",
    en: "Compare product prices across Yahoo Shopping and PChome 24h.",
    ja: "YahooショッピングとPChome 24hの商品価格を比較します。",
  },
  usage: {
    zh: "比價 iPhone 16\n比價 Sony WH-1000XM5",
    en: "compare iPhone 16\ncompare Sony WH-1000XM5",
    ja: "比價 iPhone 16",
  },
  category: {
    zh: "購物消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "比價",
  triggerAliases: ["比比看", "查價", "compare", "price"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 30 分鐘；可填 10m、1h", default: "30" },
    { key: "maxResults", label: { zh: "每平台最多顯示筆數", en: "Max results per source", ja: "ソース毎の最大件数" }, hint: "預設 5；1–10", default: "5" },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "比價", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const keyword = ctx.args.replace(/請幫忙|請幫|幫忙|麻煩|幫我|幫|比價|比比看|查價|compare|price/gi, " ").trim();
    if (!keyword) {
      await ctx.reply("用法：比價 <商品名稱>\n例如：比價 iPhone 16");
      return;
    }

    const maxResults = Math.min(Math.max(Number(ctx.config.maxResults) || 5, 1), 10);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);
    const cacheKey = `price-compare-${keyword}`;
    let allResults = readCache<ProductResult[]>(cacheKey, ttlMs);

    if (!allResults || allResults.length === 0) {
      allResults = [];
      for (const src of SOURCES) {
        try {
          const url = src.searchUrl(keyword);
          const html = await netFetchText(url, {
            headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "zh-TW,zh;q=0.9" },
          }, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024 });
          const items = src.parse(html, url);
          allResults.push(...items.slice(0, maxResults));
        } catch (error) {
          logger.warn("比價抓取失敗", { source: src.name, keyword, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (allResults.length > 0) writeCache(cacheKey, allResults);
    }

    if (allResults.length === 0) {
      await ctx.reply(`搜尋「${keyword}」找不到結果，請換個關鍵字試試。`);
      return;
    }

    const grouped = new Map<string, ProductResult[]>();
    for (const r of allResults) {
      const list = grouped.get(r.source) ?? [];
      list.push(r);
      grouped.set(r.source, list);
    }

    const lines: string[] = [];
    for (const [source, items] of grouped) {
      lines.push(`【${source}】`);
      for (const item of items) {
        lines.push(`${fmtPrice(item.price)} ${item.title}`);
      }
      lines.push("");
    }

    const sorted = [...allResults].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0];
    lines.push(`💰 最便宜：${cheapest.source} ${fmtPrice(cheapest.price)}`);

    logger.info("比價查詢", { keyword, count: allResults.length });
    await ctx.reply(`🔍 搜尋「${keyword}」找到 ${allResults.length} 筆：\n\n${lines.join("\n")}`);
  },
};

export default priceCompareSkill;
