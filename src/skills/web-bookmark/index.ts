import { logger } from "@lw/logger";
import { fetchText as netFetchText } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "@lw/skills/types";

const TASK = "bookmarks";
const MAX_BOOKMARKS = 100;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; ImHook/1.0)";
const URL_RE = /https?:\/\/[^\s]+/i;

interface Bookmark {
  id: string;
  url: string;
  title: string;
  /** 舊資料單標籤（讀取時自動併入 tags，不再寫入）。 */
  tag?: string;
  tags?: string[];
  addedBy: string;
  addedByName: string;
  addedAt: number;
  lastCheck?: number;
  /** 首次發現失效的時間（ms）；恢復正常時清掉。 */
  deadSince?: number | null;
}

export interface NormalizedBookmark extends Omit<Bookmark, "tag" | "tags"> {
  tags: string[];
}

/** 正規化：舊單標籤併入 tags 陣列並去重（冪等）。 */
export function normalizeBookmark(bm: Bookmark): NormalizedBookmark {
  const copy = { ...bm };
  const tags = [...(Array.isArray(copy.tags) ? copy.tags : []), ...(copy.tag ? [copy.tag] : [])].filter(
    (t): t is string => !!t,
  );
  delete copy.tag;
  return { ...copy, tags: [...new Set(tags)] };
}

interface BookmarkState {
  bookmarks: Bookmark[];
}

function readBookmarks(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): NormalizedBookmark[] {
  const state = ctx.taskState(TASK) as Partial<BookmarkState> | undefined;
  const list = Array.isArray(state?.bookmarks) ? (state.bookmarks as Bookmark[]) : [];
  return list.map(normalizeBookmark);
}

function genId(): string {
  return Date.now().toString(36).slice(-5);
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

async function fetchTitle(url: string): Promise<string> {
  try {
    const html = await netFetchText(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    }, { timeoutMs: 10_000, maxBytes: 200 * 1024, blockPrivate: true });
    return extractTitle(html);
  } catch {
    return "";
  }
}

export function renderList(items: Bookmark[]): string {
  return items.map((raw, i) => {
    const b = normalizeBookmark(raw);
    const tag = b.tags.length > 0 ? ` ${b.tags.map((t) => `#${t}`).join(" ")}` : "";
    const dead = b.deadSince ? "（連結失效）" : "";
    return `${i + 1}. ${b.title || b.url}${tag}${dead}\n   ${b.url}`;
  }).join("\n");
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    await netFetchText(
      url,
      { headers: { "User-Agent": UA } },
      { timeoutMs: 8000, maxBytes: 50 * 1024, blockPrivate: true },
    );
    return true;
  } catch {
    return false;
  }
}

export interface LinkCheckResult {
  checked: number;
  newlyDead: string[];
  revived: number;
  stillDead: number;
}

/**
 * 連結健檢：每次最多檢查 limit 筆（上次最久沒檢查的優先）。
 * 成功→清除失效標記；失敗→首次標記 deadSince；已標記者維持。
 */
export async function checkLinks(
  items: NormalizedBookmark[],
  limit = 15,
): Promise<{ items: NormalizedBookmark[]; result: LinkCheckResult }> {
  const targets = new Set(
    [...items].sort((a, b) => (a.lastCheck ?? 0) - (b.lastCheck ?? 0)).slice(0, limit).map((b) => b.id),
  );
  const newlyDead: string[] = [];
  let checked = 0;
  let revived = 0;
  const updated = await Promise.all(
    items.map(async (b) => {
      if (!targets.has(b.id)) return b;
      checked++;
      const now = Date.now();
      if (await probeUrl(b.url)) {
        if (b.deadSince) revived++;
        return { ...b, lastCheck: now, deadSince: null };
      }
      if (b.deadSince) return { ...b, lastCheck: now };
      newlyDead.push(b.title || b.url);
      return { ...b, lastCheck: now, deadSince: now };
    }),
  );
  return {
    items: updated,
    result: { checked, newlyDead, revived, stillDead: updated.filter((b) => b.deadSince).length },
  };
}

const bookmarkSkill: SkillDefinition = {
  id: "web-bookmark",
  name: "網頁收藏",
  description: {
    zh: "收藏網頁連結，方便日後查找。",
    en: "Save web bookmarks for later reference.",
    ja: "Web ブックマークを保存して後で確認できます。",
  },
  usage: {
    zh: "收藏 https://example.com #工具 #重要\n收藏 清單\n收藏 #工具（只看該標籤）\n收藏 標籤（所有標籤）\n收藏 搜尋 關鍵字\n收藏 刪除 3\n收藏 檢查（連結健檢）",
    en: "bookmark https://example.com #tools\nbookmark list\nbookmark search keyword\nbookmark delete 3",
    ja: "收藏 https://example.com #ツール\n收藏 清單\n收藏 搜尋 キーワード\n收藏 刪除 3",
  },
  category: {
    zh: "工具",
    en: "Utilities",
    ja: "ツール",
  },
  defaultTrigger: "收藏",
  triggerAliases: ["bookmark", "書籤", "save"],
  fields: [
    { key: "maxBookmarks", label: { zh: "收藏上限", en: "Max bookmarks", ja: "最大ブックマーク数" }, hint: "預設 100；1–500", default: "100" },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "網頁收藏", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const bookmarks = readBookmarks(ctx);
    const save = (updated: Bookmark[]) => {
      ctx.watch({ task: TASK, everyMinutes: 1440, state: { bookmarks: updated } });
    };

    const args = ctx.args.replace(/請幫忙|請幫|幫忙|麻煩|幫我|幫/g, " ").trim();

    if (!args) {
      await ctx.reply(
        "用法：\n收藏 https://example.com #標籤\n收藏 清單\n收藏 #標籤（只看該標籤）\n收藏 標籤（所有標籤）\n收藏 搜尋 關鍵字\n收藏 刪除 1\n收藏 檢查（連結健檢）",
      );
      return;
    }

    // 清單
    if (/^(清單|list|列表)$/i.test(args)) {
      if (bookmarks.length === 0) {
        await ctx.reply("目前沒有收藏。用「收藏 <網址>」新增。");
        return;
      }
      await ctx.reply(`收藏清單（共 ${bookmarks.length} 筆）：\n${renderList(bookmarks)}`);
      return;
    }

    // 標籤一覽
    if (/^(標籤|標簽|tags?)$/i.test(args)) {
      const counts = new Map<string, number>();
      for (const b of bookmarks) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (counts.size === 0) {
        await ctx.reply("還沒有任何標籤。新增時加上 #標籤，例如：收藏 https://example.com #工具");
        return;
      }
      const lines = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `#${t}（${n}）`);
      await ctx.reply(`標籤（${counts.size}）：\n${lines.join("\n")}\n用「收藏 #標籤」只看該類。`);
      return;
    }

    // 標籤篩選（收藏 #工具）
    const tagFilter = /^#([^\s#]+)$/.exec(args);
    if (tagFilter) {
      const want = tagFilter[1].toLowerCase();
      const hits = bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === want));
      if (hits.length === 0) {
        await ctx.reply(`標籤「#${tagFilter[1]}」沒有收藏，可用「收藏 標籤」查看。`);
        return;
      }
      await ctx.reply(`#${tagFilter[1]}（${hits.length} 筆）：\n${renderList(hits)}`);
      return;
    }

    // 搜尋（標題／網址／標籤）
    const search = /^(搜尋|search|找|find)\s+(.+)$/i.exec(args);
    if (search) {
      const kw = search[2].toLowerCase();
      const hits = bookmarks.filter(
        (b) =>
          b.url.toLowerCase().includes(kw) ||
          b.title.toLowerCase().includes(kw) ||
          b.tags.some((t) => t.toLowerCase().includes(kw)),
      );
      if (hits.length === 0) {
        await ctx.reply(`搜尋「${search[2]}」沒有結果。`);
        return;
      }
      await ctx.reply(`搜尋「${search[2]}」找到 ${hits.length} 筆：\n${renderList(hits)}`);
      return;
    }

    // 刪除
    const del = /^(刪除|删除|delete|del|移除|取消)\s*(.+)?$/i.exec(args);
    if (del) {
      if (bookmarks.length === 0) {
        await ctx.reply("目前沒有收藏。");
        return;
      }
      const target = del[2]?.trim();
      let idx = -1;
      if (target && /^\d+$/.test(target)) {
        idx = Number(target) - 1;
      } else if (target) {
        idx = bookmarks.findIndex((b) => b.url.includes(target) || b.title.includes(target));
      } else {
        idx = bookmarks.length - 1;
      }
      if (idx < 0 || idx >= bookmarks.length) {
        await ctx.reply(`找不到「${target}」，請用「收藏 清單」查看編號。`);
        return;
      }
      const removed = bookmarks.splice(idx, 1)[0];
      save(bookmarks);
      await ctx.reply(`已刪除：${removed.title || removed.url}`);
      return;
    }

    // 連結健檢（手動）
    if (/^(檢查|健檢|check)$/i.test(args)) {
      if (bookmarks.length === 0) {
        await ctx.reply("目前沒有收藏。");
        return;
      }
      await ctx.reply("開始檢查連結，請稍候……");
      const { items, result } = await checkLinks(bookmarks, 30);
      save(items);
      logger.info("收藏連結健檢", { chat: ctx.chat, ...result, newlyDead: result.newlyDead.length });
      const parts = [`檢查了 ${result.checked} 筆`];
      if (result.newlyDead.length > 0) parts.push(`新發現失效 ${result.newlyDead.length} 筆：\n${result.newlyDead.map((t) => `・${t}`).join("\n")}`);
      if (result.revived > 0) parts.push(`恢復正常 ${result.revived} 筆`);
      if (result.newlyDead.length === 0 && result.revived === 0) parts.push("連結都正常");
      await ctx.reply(parts.join("，"));
      return;
    }

    // 新增
    const url = URL_RE.exec(args)?.[0];
    if (!url) {
      await ctx.reply("請提供網址，例如：收藏 https://example.com #工具");
      return;
    }

    const max = Math.min(Math.max(Number(ctx.config.maxBookmarks) || MAX_BOOKMARKS, 1), 500);
    if (bookmarks.length >= max) {
      await ctx.reply(`收藏已達上限（${max} 筆），請先刪除舊的。`);
      return;
    }

    const tags = [...new Set([...args.matchAll(/#([^\s#]+)/g)].map((m) => m[1]))];
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) {
      const merged = [...new Set([...existing.tags, ...tags])];
      if (merged.length > existing.tags.length) {
        existing.tags = merged;
        save(bookmarks);
        await ctx.reply(`已經收藏過這個網址了，已補上標籤：${merged.map((t) => `#${t}`).join(" ")}`);
      } else {
        await ctx.reply("已經收藏過這個網址了。");
      }
      return;
    }

    const title = await fetchTitle(url);

    const bm: NormalizedBookmark = {
      id: genId(),
      url,
      title: title || url,
      tags,
      addedBy: ctx.fromMid,
      addedByName: ctx.fromName,
      addedAt: Date.now(),
    };
    const updated = [...bookmarks, bm];
    save(updated);
    logger.info("網頁收藏", { url, tags, title: bm.title });
    await ctx.reply(`已收藏：${bm.title}${tags.length > 0 ? ` ${tags.map((t) => `#${t}`).join(" ")}` : ""}\n${url}\n（共 ${updated.length} 筆收藏）`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<BookmarkState>;
    const raw: Bookmark[] = Array.isArray(state.bookmarks) ? state.bookmarks : [];
    let bookmarks = raw.map(normalizeBookmark);
    if (bookmarks.length > 500) {
      bookmarks = bookmarks.slice(-500);
    }
    if (bookmarks.length === 0) {
      if (raw.length !== bookmarks.length) await ctx.saveState({ bookmarks });
      return;
    }
    // 每日輪查 15 筆（上次最久沒檢查的優先）；新失效才推播，避免每天轟炸。
    const { items, result } = await checkLinks(bookmarks, 15);
    await ctx.saveState({ bookmarks: items });
    if (result.newlyDead.length > 0) {
      logger.info("收藏連結失效通知", { chat: ctx.chat, count: result.newlyDead.length });
      await ctx.reply(`⚠ 以下收藏連結疑似失效：\n${result.newlyDead.map((t) => `・${t}`).join("\n")}`);
    }
  },
};

export default bookmarkSkill;
