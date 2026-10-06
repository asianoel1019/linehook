import { logger } from "../../logger.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";

const TASK = "bookmarks";
const MAX_BOOKMARKS = 100;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const URL_RE = /https?:\/\/[^\s]+/i;

interface Bookmark {
  id: string;
  url: string;
  title: string;
  tag: string;
  addedBy: string;
  addedByName: string;
  addedAt: number;
}

interface BookmarkState {
  bookmarks: Bookmark[];
}

function readBookmarks(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): Bookmark[] {
  const state = ctx.taskState(TASK) as Partial<BookmarkState> | undefined;
  return Array.isArray(state?.bookmarks) ? (state.bookmarks as Bookmark[]) : [];
}

function genId(): string {
  return Date.now().toString(36).slice(-5);
}

function extractTitle(html: string): string {
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

function renderList(items: Bookmark[]): string {
  return items.map((b, i) => {
    const tag = b.tag ? ` #${b.tag}` : "";
    return `${i + 1}. ${b.title || b.url}${tag}\n   ${b.url}`;
  }).join("\n");
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
    zh: "收藏 https://example.com #工具\n收藏 清單\n收藏 搜尋 關鍵字\n收藏 刪除 3",
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
        "用法：\n收藏 https://example.com #標籤\n收藏 清單\n收藏 搜尋 關鍵字\n收藏 刪除 1",
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

    // 搜尋
    const search = /^(搜尋|search|找|find)\s+(.+)$/i.exec(args);
    if (search) {
      const kw = search[2].toLowerCase();
      const hits = bookmarks.filter(
        (b) =>
          b.url.toLowerCase().includes(kw) ||
          b.title.toLowerCase().includes(kw) ||
          b.tag.toLowerCase().includes(kw),
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

    if (bookmarks.some((b) => b.url === url)) {
      await ctx.reply("已經收藏過這個網址了。");
      return;
    }

    const tagMatch = /#([^\s#]+)/.exec(args);
    const tag = tagMatch ? tagMatch[1] : "";
    const title = await fetchTitle(url);

    const bm: Bookmark = {
      id: genId(),
      url,
      title: title || url,
      tag,
      addedBy: ctx.fromMid,
      addedByName: ctx.fromName,
      addedAt: Date.now(),
    };
    const updated = [...bookmarks, bm];
    save(updated);
    logger.info("網頁收藏", { url, tag, title: bm.title });
    await ctx.reply(`已收藏：${bm.title}${tag ? ` #${tag}` : ""}\n${url}\n（共 ${updated.length} 筆收藏）`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<BookmarkState>;
    const bookmarks: Bookmark[] = Array.isArray(state.bookmarks) ? state.bookmarks : [];
    if (bookmarks.length > 500) {
      await ctx.saveState({ bookmarks: bookmarks.slice(-500) });
    }
  },
};

export default bookmarkSkill;
