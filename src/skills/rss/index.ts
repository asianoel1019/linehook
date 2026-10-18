import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchText as netFetchText } from "@lw/net";
import { nowInTz } from "@lw/time";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "@lw/skills/types";
import { describeWatch } from "@lw/skills/watch";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; ImHook/1.0)";
const URL_RE = /https?:\/\/[^\s]+/i;
const TASK = "poll";
const MAX_SUBS = 10;
const MAX_NEW_PER_FEED = 5;
const MAX_DIGEST_ITEMS = 20;
const KEEP_SEEN = 30;

interface Subscription {
  url: string;
  alias: string;
  lastSeen: string[];
  /** 包含關鍵字（任一命中才推送）；空 = 全部。 */
  include: string[];
  /** 排除關鍵字（任一命中就丟棄）。 */
  exclude: string[];
  /** 摘要模式：不即時推，累積到 digestAt 一次匯整。 */
  digest: boolean;
}

interface DigestBufferItem {
  alias: string;
  items: FeedItem[];
}

interface PollState {
  subs: Subscription[];
  digestBuffer: DigestBufferItem[];
  /** 下次摘要沖洗時間（epoch ms）；0 = 未設定。 */
  nextDigestAt: number;
}

export interface FeedItem {
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
    {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    },
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
  return normalizeSubs(state?.subs);
}

/** 正規化訂閱清單（舊資料相容：補上 include/exclude/digest 預設值）。 */
function normalizeSubs(raw: unknown): Subscription[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Partial<Subscription>>).map((s) => ({
    url: s.url ?? "",
    alias: s.alias ?? "",
    lastSeen: Array.isArray(s.lastSeen) ? s.lastSeen : [],
    include: Array.isArray(s.include) ? s.include : [],
    exclude: Array.isArray(s.exclude) ? s.exclude : [],
    digest: s.digest === true,
  }));
}

function readDigestState(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): {
  buffer: DigestBufferItem[];
  nextDigestAt: number;
} {
  const state = ctx.taskState(TASK) as Partial<PollState> | undefined;
  return {
    buffer: Array.isArray(state?.digestBuffer) ? (state.digestBuffer as DigestBufferItem[]) : [],
    nextDigestAt: typeof state?.nextDigestAt === "number" ? state.nextDigestAt : 0,
  };
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "30");
  return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : 30;
}

/** 摘要沖洗時間（預設 08:00）。 */
export function digestAtOf(config: Record<string, string>): string {
  const m = /^\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*$/.exec(config.digestAt ?? "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "08:00";
}

/** 下一個「每日 digestAt」的 epoch ms。 */
export function nextDigestRun(digestAt: string, from = Date.now()): number {
  const [hh, mm] = digestAt.split(":").map(Number);
  const now = nowInTz();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();
  return today > from ? today : today + 86_400_000;
}

/** 訂閱參數解析：「含:a,b」「排除:c」「摘要」。 */
export function parseFilters(args: string): { include: string[]; exclude: string[]; digest: boolean } {
  const include =
    /含[:：]?\s*([^\s]+)/
      .exec(args)?.[1]
      ?.split(/[,，、]+/)
      .filter(Boolean) ?? [];
  const exclude =
    /排(?:除|斥)?[:：]?\s*([^\s]+)/
      .exec(args)?.[1]
      ?.split(/[,，、]+/)
      .filter(Boolean) ?? [];
  const digest = /摘要|匯整|digest/i.test(args);
  return { include, exclude, digest };
}

/** 依 include/exclude 規則過濾項目（標題不分大小寫比對）。 */
export function filterItems(items: FeedItem[], sub: Pick<Subscription, "include" | "exclude">): FeedItem[] {
  const inc = (sub.include ?? []).filter(Boolean);
  const exc = (sub.exclude ?? []).filter(Boolean);
  return items.filter((it) => {
    const t = it.title.toLowerCase();
    if (inc.length > 0 && !inc.some((k) => t.includes(k.toLowerCase()))) return false;
    if (exc.some((k) => t.includes(k.toLowerCase()))) return false;
    return true;
  });
}

function subBadge(sub: Subscription): string {
  const parts: string[] = [];
  if (sub.include.length > 0) parts.push(`含 ${sub.include.join(",")}`);
  if (sub.exclude.length > 0) parts.push(`排 ${sub.exclude.join(",")}`);
  if (sub.digest) parts.push("摘要");
  return parts.length > 0 ? `（${parts.join("・")}）` : "";
}

const rssSkill: SkillDefinition = {
  id: "rss",
  name: "RSS 訂閱摘要",
  description: {
    zh: "讀取 RSS/Atom 摘要；訂閱可關鍵字過濾（含/排除）或改每日摘要彙整。",
    en: "Read RSS/Atom feeds; subscriptions support keyword filters and daily digest mode.",
    ja: "RSS/Atom フィードを読み取り。購読はキーワード絞り込み（含む/除外）や毎日ダイジェストにも対応。",
  },
  usage: {
    zh: "訂閱 https://example.com/feed.xml；rss 訂閱 https://example.com/feed.xml 含:apple 排除:rumor 摘要；rss 清單",
    en: "rss https://example.com/feed.xml 5; rss subscribe https://example.com/feed.xml include:apple exclude:rumor digest; rss list",
    ja: "rss https://example.com/feed.xml 5；rss 購読 https://example.com/feed.xml 含:apple 除外:rumor ダイジェスト；rss 一覧",
  },
  category: { zh: "內容訂閱", en: "Feeds", ja: "フィード" },
  defaultTrigger: "rss",
  triggerAliases: ["訂閱", "摘要", "feed", "訂閱摘要"],
  fields: [
    {
      key: "cacheTtl",
      label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" },
      hint: "預設 30 分鐘；可填 10m、1h",
    },
    {
      key: "pollMinutes",
      label: { zh: "推播檢查間隔（分鐘）", en: "Poll interval (min)", ja: "チェック間隔（分）" },
      hint: "預設 30；5–1440",
    },
    {
      key: "digestAt",
      label: { zh: "每日摘要沖洗時間", en: "Daily digest time", ja: "毎日ダイジェスト時刻" },
      hint: "預設 08:00（HH:mm）",
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
      const key = ctx.args
        .replace(/請幫忙|請幫|幫忙|退訂|取消|刪除|移除|的/g, " ")
        .replace(url ?? "", " ")
        .trim();
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
      const digestOff = removed.digest && subs.every((s) => !s.digest);
      if (subs.length === 0) {
        ctx.unwatch(TASK);
        await ctx.reply(`已退訂：${removed.alias}（已無訂閱，停止檢查）`);
        return;
      }
      ctx.watch({
        ...watchOpts,
        state: {
          subs,
          digestBuffer: digestOff ? [] : readDigestState(ctx).buffer,
          nextDigestAt: digestOff ? 0 : readDigestState(ctx).nextDigestAt,
        },
      });
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
      const lines = subs.map((s, i) => `${i + 1}. ${s.alias}${subBadge(s)}\n  ${s.url}`);
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
        await ctx.reply("已經訂閱過這個網址了。（可退訂後重新訂閱以修改過濾條件）");
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
      const filters = parseFilters(ctx.args.replace(url, " "));
      const alias =
        ctx.args
          .replace(/請幫忙|請幫|幫忙|訂閱|的/g, " ")
          .replace(url, " ")
          .replace(/含[:：]?\s*[^\s]+/g, " ")
          .replace(/排(?:除|斥)?[:：]?\s*[^\s]+/g, " ")
          .replace(/摘要|匯整/g, " ")
          .trim() || defaultAlias(url, feed.title);
      const sub: Subscription = {
        url,
        alias,
        lastSeen: feed.items.slice(0, KEEP_SEEN).map(itemId),
        include: filters.include,
        exclude: filters.exclude,
        digest: filters.digest,
      };
      subs.push(sub);
      const digestState = readDigestState(ctx);
      const nextDigestAt =
        filters.digest && digestState.nextDigestAt === 0
          ? nextDigestRun(digestAtOf(ctx.config))
          : digestState.nextDigestAt;
      ctx.watch({ ...watchOpts, state: { subs, digestBuffer: digestState.buffer, nextDigestAt } });
      const modeNote = filters.digest
        ? `，採每日摘要（${digestAtOf(ctx.config)} 匯整）`
        : filters.include.length + filters.exclude.length > 0
          ? `，已套用過濾${subBadge(sub)}`
          : "";
      await ctx.reply(`已訂閱：${alias}${modeNote}（${describeWatch(watchOpts)}檢查新文章）\n${url}`);
      return;
    }

    // 單次摘要（原行為；已訂閱者套用其過濾條件）
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

    const sub = readSubs(ctx).find((s) => s.url === url);
    const visible = sub ? filterItems(feed.items, sub) : feed.items;
    if (visible.length === 0) {
      await ctx.reply(sub ? `「${sub.alias}」沒有符合過濾條件的項目。` : "這個網址讀不到項目。");
      return;
    }
    const items = visible.slice(0, limit);
    const lines = items.map((it) => {
      const date = it.date ? ` (${shortDate(it.date)})` : "";
      return `・${it.title}${date}${it.link ? `\n  ${it.link}` : ""}`;
    });
    const head = feed.title ? `${feed.title}\n` : "";
    logger.info("RSS 摘要", { url, count: items.length });
    await ctx.reply(`${head}最新 ${items.length} 則：\n${lines.join("\n")}`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<PollState>;
    const subs = normalizeSubs(state.subs);
    if (subs.length === 0) return;

    const buffer: DigestBufferItem[] = Array.isArray(state.digestBuffer) ? [...state.digestBuffer] : [];
    let nextDigestAt = typeof state.nextDigestAt === "number" ? state.nextDigestAt : 0;
    const hasDigest = subs.some((s) => s.digest);
    if (hasDigest && nextDigestAt === 0) nextDigestAt = nextDigestRun(digestAtOf(ctx.config));

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

      const matched = filterItems(fresh, sub);
      if (matched.length > 0 && sub.digest) {
        // 摘要模式：進緩衝區，不即時推播。
        const slot = buffer.find((b) => b.alias === sub.alias) ?? { alias: sub.alias, items: [] };
        slot.items = [...slot.items, ...matched].slice(-MAX_DIGEST_ITEMS);
        if (!buffer.includes(slot)) buffer.push(slot);
        changed = true;
      } else if (matched.length > 0) {
        const show = matched.slice(0, MAX_NEW_PER_FEED);
        const lines = show.map((it) => `・${it.title}${it.link ? `\n  ${it.link}` : ""}`);
        const more = matched.length > show.length ? `\n（另有 ${matched.length - show.length} 則未列出）` : "";
        const filtered = fresh.length !== matched.length ? `（過濾掉 ${fresh.length - matched.length} 則）` : "";
        await ctx.reply(`📰 ${sub.alias} 有 ${matched.length} 則更新${filtered}：\n${lines.join("\n")}${more}`);
      }
      sub.lastSeen = [...fresh.map(itemId), ...sub.lastSeen].slice(0, KEEP_SEEN);
      changed = true;
    }

    // 每日摘要沖洗
    if (hasDigest && buffer.length > 0 && Date.now() >= nextDigestAt) {
      const blocks: string[] = [];
      let total = 0;
      for (const slot of buffer) {
        total += slot.items.length;
        const lines = slot.items.map((it) => `・${it.title}${it.link ? `\n  ${it.link}` : ""}`);
        blocks.push(`【${slot.alias}】\n${lines.join("\n")}`);
      }
      await ctx.reply(`📬 RSS 每日摘要（共 ${total} 則）：\n${blocks.join("\n\n")}`);
      buffer.length = 0;
      nextDigestAt = nextDigestRun(digestAtOf(ctx.config));
      changed = true;
    }

    if (changed) {
      await ctx.saveState({ subs, digestBuffer: buffer, nextDigestAt });
    }
  },
};

export default rssSkill;
