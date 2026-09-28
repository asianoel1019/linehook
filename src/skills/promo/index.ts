import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const CACHE_NAME = "store-promos";

interface Promo {
  store: string;
  title: string;
  link: string;
  date: string;
  source: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<string> {
  return netFetchText(
    url,
    { headers: { "User-Agent": UA } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

/** 將各種日期字串（RFC / ISO）正規化為 YYYY/MM/DD。 */
function normDate(s: string): string {
  if (!s) return "";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s.slice(0, 10);
  const d = new Date(t);
  const p = (n: number) => ("0" + n).slice(-2);
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

async function fromGoogleNews(store: string, query: string): Promise<Promo[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const xml = await fetchText(url);
  const out: Promo[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = decode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "");
    const link = decode((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ?? "");
    const date = decode((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] ?? "");
    const source = decode((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] ?? "Google 新聞");
    if (!rawTitle || !link) continue;
    const title = rawTitle.replace(/\s*-\s*[^-]+$/, "").trim() || rawTitle;
    out.push({ store, title, link, date: normDate(date), source });
  }
  return out;
}

async function fromCarrefourPosts(): Promise<Promo[]> {
  const url = "https://www.uni-prosperity.com.tw/wp-json/wp/v2/posts?per_page=15&_fields=title,link,date";
  const data = (await fetchText(url)) as unknown;
  const arr = JSON.parse(typeof data === "string" ? data : JSON.stringify(data)) as Array<{
    date?: string;
    link?: string;
    title?: { rendered?: string };
  }>;
  const out: Promo[] = [];
  for (const p of arr) {
    const title = decode(p.title?.rendered ?? "");
    if (!title || /test|測試/i.test(title) || title.length < 5) continue;
    out.push({ store: "家樂福", title, link: p.link ?? "", date: normDate(p.date ?? ""), source: "家樂福官網" });
  }
  return out;
}

function sortKey(date: string): number {
  const t = Date.parse(date);
  return Number.isNaN(t) ? 0 : t;
}

async function collect(ttlMs: number): Promise<Promo[]> {
  const cached = readCache<Promo[]>(CACHE_NAME, ttlMs);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const tasks: Array<Promise<Promo[]>> = [
    fromGoogleNews("全聯", "全聯 優惠"),
    fromGoogleNews("家樂福", "家樂福 優惠"),
    fromCarrefourPosts().catch(() => []),
  ];
  const results = await Promise.all(tasks.map((p) => p.catch((e) => {
    logger.warn("促銷來源失敗", { error: e instanceof Error ? e.message : String(e) });
    return [] as Promo[];
  })));
  const all = results.flat();
  if (all.length === 0) throw new Error("所有來源皆無資料");

  const seen = new Set<string>();
  const deduped = all.filter((p) => {
    const key = p.title.slice(0, 18);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => sortKey(b.date) - sortKey(a.date));
  const limited = deduped.slice(0, 40);
  writeCache(CACHE_NAME, limited);
  logger.info("促銷資料已更新", { count: limited.length });
  return limited;
}

const promoSkill: SkillDefinition = {
  id: "promo",
  name: "全聯 / 家樂福促銷",
  description: {
    zh: "查詢全聯、家樂福（萬家福）近期促銷與優惠情報。",
    en: "Recent promos at PX Mart and Carrefour (Wanjiafu) Taiwan.",
    ja: "全聯（PXマート）とカルフール（万佳福）の最新セール情報。",
  },
  usage: {
    zh: "促銷 全聯 或 促銷 家樂福 買一送一",
    en: "promo PX Mart or promo Carrefour",
    ja: "促銷 全聯 または 促銷 家樂福",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "促銷",
  triggerAliases: ["全聯", "家樂福", "萬家福", "特價", "賣場優惠"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: { zh: "預設 6 小時；可填 2h、360", en: "Default 6h; e.g. 2h, 360", ja: "既定 6 時間；例 2h、360" } },
  ],
  async health(): Promise<SkillHealth[]> {
    const results: SkillHealth[] = [];
    for (const [name, url] of [
      ["Google 新聞", "https://news.google.com/rss/search?q=%E5%85%A8%E8%81%AF&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"],
      ["家樂福官網", "https://www.uni-prosperity.com.tw/wp-json/wp/v2/posts?per_page=1&_fields=title"],
    ] as Array<[string, string]>) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(15_000),
        });
        results.push({ name, ok: res.ok, detail: `HTTP ${res.status}` });
      } catch {
        results.push({ name, ok: false, detail: "連線失敗" });
      }
    }
    return results;
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 360);
    const full = ctx.text;
    const store = /全聯/.test(full) ? "全聯" : /家樂福|萬家福/.test(full) ? "家樂福" : "";
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|幫我|查詢|查一下|促銷|優惠|特價|活動|的|全聯|家樂福|萬家福/g, " ")
      .trim();

    let promos: Promo[];
    try {
      promos = await collect(ttlMs);
    } catch (error) {
      logger.error("促銷查詢失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("目前無法取得促銷資料，請稍後再試。");
      return;
    }

    let list = promos;
    if (store) list = list.filter((p) => p.store === store);
    if (keyword) list = list.filter((p) => p.title.includes(keyword));
    list = list.slice(0, 8);

    if (list.length === 0) {
      await ctx.reply(`查不到${store ? `${store} ` : ""}符合的促銷情報${keyword ? `（${keyword}）` : ""}。`);
      return;
    }

    const lines = list.map((p) => {
      const src = p.source && p.source !== "Google 新聞" ? `（${p.source}）` : "";
      return `・[${p.store}] ${p.title}${p.date ? ` ${p.date}` : ""}${src}\n  ${p.link}`;
    });
    logger.info("促銷查詢", { store, keyword, count: list.length });
    await ctx.reply(`${store || "全聯 / 家樂福"}促銷情報：\n${lines.join("\n")}`);
  },
};

export default promoSkill;
