import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";
import { describeWatch } from "../watch.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const URL_RE = /https?:\/\/[^\s]+/i;
const TASK = "poll";
const MAX_SUBS = 10;
const MAX_NEW_PER_FEED = 5;
const KEEP_SEEN = 30;

interface Subscription {
  url: string;
  alias: string;
  lastSeen: string[];
}

interface PollState {
  subs: Subscription[];
}

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

function itemId(it: FeedItem): string {
  return it.link || it.title;
}

async function fetchFeed(url: string): Promise<Feed> {
  const xml = await netFetchText(
    url,
    { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
  return parseFeed(xml);
}

function defaultAlias(url: string, title: string): string {
  if (title) return title.slice(0, 20);
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 20);
  }
}

function readSubs(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): Subscription[] {
  const state = ctx.taskState(TASK) as Partial<PollState> | undefined;
  return Array.isArray(state?.subs) ? (state.subs as Subscription[]) : [];
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "30");
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : 30;
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
    zh: "rss https://example.com/feed.xml 5；rss 訂閱 https://example.com/feed.xml",
    en: "rss https://example.com/feed.xml 5; rss subscribe https://example.com/feed.xml",
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
    {
      key: "pollMinutes",
      label: { zh: "推播檢查間隔（分鐘）", en: "Poll interval (min)", ja: "チェック間隔（分）" },
      hint: "預設 30；5–1440",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "RSS 解析", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const minutes = pollMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };

    // 退訂：rss 退訂 <別名|網址>
    if (/退訂|取消|刪除|移除/.test(ctx.args)) {
      const subs = readSubs(ctx);
      const url = URL_RE.exec(ctx.args)?.[0];
      const key = ctx.args.replace(/請幫忙|請幫|幫忙|退訂|取消|刪除|移除|的/g, " ").replace(url ?? "", " ").trim();
      if (!url && !key) {
        await ctx.reply("用法：阿寶請幫忙 rss 退訂 <別名或網址>");
        return;
      }
      const idx = url
        ? subs.findIndex((s) => s.url === url)
        : subs.findIndex((s) => s.alias.includes(key) || key.includes(s.alias));
      if (idx < 0) {
        await ctx.reply(`找不到訂閱「${url ?? key}」，請用「rss 清單」查看。`);
        return;
      }
      const removed = subs[idx];
      subs.splice(idx, 1);
      if (subs.length === 0) {
        ctx.unwatch(TASK);
        await ctx.reply(`已退訂：${removed.alias}（已無訂閱，停止檢查）`);
        return;
      }
      ctx.watch({ ...watchOpts, state: { subs } });
      await ctx.reply(`已退訂：${removed.alias}\n剩下 ${subs.length} 個訂閱。`);
      return;
    }

    // 清單
    if (/清單|列表/.test(ctx.args)) {
      const subs = readSubs(ctx);
      if (subs.length === 0) {
        await ctx.reply("目前沒有 RSS 訂閱。用法：阿寶請幫忙 rss 訂閱 https://example.com/feed.xml");
        return;
      }
      const lines = subs.map((s, i) => `${i + 1}. ${s.alias}\n  ${s.url}`);
      await ctx.reply(`RSS 訂閱共 ${subs.length} 個（${describeWatch(watchOpts)}檢查）：\n${lines.join("\n")}`);
      return;
    }

    const url = URL_RE.exec(ctx.args)?.[0];
    if (!url) {
      await ctx.reply("請提供 RSS 網址，例如：阿寶請幫忙 rss https://feeds.feedburner.com/example 5");
      return;
    }

    // 訂閱：args 含「訂閱」，或觸發詞本身就是「訂閱」（全文含觸發詞時 args 已不帶它）
    const subscribe = /訂閱/.test(ctx.args) || (/^https?:\/\/[^\s]+$/i.test(ctx.args.trim()) && /訂閱/.test(ctx.text));
    if (subscribe) {
      const subs = readSubs(ctx);
      if (subs.some((s) => s.url === url)) {
        await ctx.reply("已經訂閱過這個網址了。");
        return;
      }
      if (subs.length >= MAX_SUBS) {
        await ctx.reply(`訂閱已達上限（${MAX_SUBS} 個），請先退訂舊的。`);
        return;
      }
      let feed: Feed;
      try {
        feed = await fetchFeed(url);
      } catch (error) {
        logger.warn("RSS 訂閱抓取失敗", { url, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("無法讀取這個 RSS 網址，請確認連結是否正確。");
        return;
      }
      if (feed.items.length === 0) {
        await ctx.reply("這個網址讀不到項目，請確認是否為 RSS/Atom feed。");
        return;
      }
      const alias = ctx.args.replace(/請幫忙|請幫|幫忙|訂閱|的/g, " ").replace(url, " ").trim() || defaultAlias(url, feed.title);
      subs.push({ url, alias, lastSeen: feed.items.slice(0, KEEP_SEEN).map(itemId) });
      ctx.watch({ ...watchOpts, state: { subs } });
      await ctx.reply(`已訂閱：${alias}（${describeWatch(watchOpts)}檢查新文章）\n${url}`);
      return;
    }

    // 單次摘要（原行為）
    const numMatch = ctx.args.replace(url, "").match(/(\d{1,2})/);
    const limit = Math.min(Math.max(numMatch ? Number(numMatch[1]) : 8, 1), 20);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);
    const cacheKey = `rss-${url}`;

    let feed = readCache<Feed>(cacheKey, ttlMs);
    if (!feed || !Array.isArray(feed.items) || feed.items.length === 0) {
      try {
        feed = await fetchFeed(url);
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
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as { subs?: Subscription[] };
    const subs: Subscription[] = Array.isArray(state.subs) ? state.subs : [];
    if (subs.length === 0) return;
    let changed = false;
    for (const sub of subs) {
      let feed: Feed;
      try {
        feed = await fetchFeed(sub.url);
      } catch (error) {
        logger.warn("RSS 輪詢失敗，保留舊狀態", {
          url: sub.url,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const seen = new Set(sub.lastSeen);
      const fresh = feed.items.filter((it) => !seen.has(itemId(it)));
      if (fresh.length === 0) continue;
      const show = fresh.slice(0, MAX_NEW_PER_FEED);
      const lines = show.map((it) => `・${it.title}${it.link ? `\n  ${it.link}` : ""}`);
      const more = fresh.length > show.length ? `\n（另有 ${fresh.length - show.length} 則未列出）` : "";
      await ctx.reply(`📰 ${sub.alias} 有 ${fresh.length} 則更新：\n${lines.join("\n")}${more}`);
      sub.lastSeen = [...fresh.map(itemId), ...sub.lastSeen].slice(0, KEEP_SEEN);
      changed = true;
    }
    if (changed) {
      await ctx.saveState({ subs });
    }
  },
};

export default rssSkill;
