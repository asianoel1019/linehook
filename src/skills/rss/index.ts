import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const URL_RE = /https?:\/\/[^\s]+/i;

interface FeedItem {
  title: string;
  link: string;
  date: string;
}

interface Feed {
  title: string;
  items: FeedItem[];
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
    const m = re.exec(block);
    if (m) {
      const val = decode(m[1]);
      if (val) return val;
    }
  }
  return "";
}

function linkOf(block: string): string {
  const href = /<link[^>]*href="([^"]+)"/i.exec(block);
  if (href) return decode(href[1]);
  return tag(block, ["link", "guid"]);
}

function parseFeed(xml: string): Feed {
  const feedTitle = tag(xml.split(/<item[\s>]/i)[0]?.split(/<entry[\s>]/i)[0] ?? "", ["title"]);
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tag(block, ["title"]);
    const link = linkOf(block);
    const date = tag(block, ["pubDate", "published", "updated", "dc:date"]);
    if (title) items.push({ title, link, date });
  }
  return { title: feedTitle, items };
}

function shortDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16);
  const p = (n: number) => ("0" + n).slice(-2);
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const rssSkill: SkillDefinition = {
  id: "rss",
  name: "RSS 訂閱摘要",
  description: {
    zh: "讀取 RSS/Atom 摘要。",
    en: "Read RSS/Atom feeds.",
    ja: "RSS/Atom フィードを読み取ります。",
  },
  usage: {
    zh: "rss https://example.com/feed.xml 5",
    en: "rss https://example.com/feed.xml 5",
    ja: "rss https://example.com/feed.xml 5",
  },
  category: {
    zh: "內容訂閱",
    en: "Feeds",
    ja: "フィード",
  },
  defaultTrigger: "rss",
  triggerAliases: ["訂閱", "摘要", "feed", "訂閱摘要"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 30 分鐘；可填 10m、1h" },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "RSS 解析", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const url = URL_RE.exec(ctx.args)?.[0];
    if (!url) {
      await ctx.reply("請提供 RSS 網址，例如：阿寶請幫忙 rss https://feeds.feedburner.com/example 5");
      return;
    }
    const numMatch = ctx.args.replace(url, "").match(/(\d{1,2})/);
    const limit = Math.min(Math.max(numMatch ? Number(numMatch[1]) : 8, 1), 20);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);
    const cacheKey = `rss-${url}`;

    let feed = readCache<Feed>(cacheKey, ttlMs);
    if (!feed || !Array.isArray(feed.items) || feed.items.length === 0) {
      try {
        const xml = await netFetchText(
          url,
          { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } },
          { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
        );
        feed = parseFeed(xml);
      } catch (error) {
        logger.warn("RSS 讀取失敗", { url, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("無法讀取這個 RSS 網址，請確認連結是否正確。");
        return;
      }
      if (feed.items.length === 0) {
        await ctx.reply("這個網址讀不到項目，請確認是否為 RSS/Atom feed。");
        return;
      }
      writeCache(cacheKey, feed);
    }

    const items = feed.items.slice(0, limit);
    const lines = items.map((it) => {
      const date = it.date ? ` (${shortDate(it.date)})` : "";
      return `・${it.title}${date}${it.link ? `\n  ${it.link}` : ""}`;
    });
    const head = feed.title ? `${feed.title}\n` : "";
    logger.info("RSS 摘要", { url, count: items.length });
    await ctx.reply(`${head}最新 ${items.length} 則：\n${lines.join("\n")}`);
  },
};

export default rssSkill;
