import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "LineHook/1.0 (https://github.com/; skill:wiki)";
const HOSTS: Record<string, string> = {
  zh: "https://zh.wikipedia.org",
  en: "https://en.wikipedia.org",
  ja: "https://ja.wikipedia.org",
};

interface WikiSummary {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { original?: string };
  lang?: string;
}

export interface WikiResult {
  lang: string;
  title: string;
  description: string;
  extract: string;
  url: string;
  thumbnail: string;
}

/** 依語言取 Wikipedia REST summary；找不到頁面回 null。 */
export async function fetchWiki(query: string, lang: string): Promise<WikiResult | null> {
  const host = HOSTS[lang] ?? HOSTS.zh;
  const url = `${host}/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, "_"))}`;
  const data = await netFetchJson<WikiSummary>(
    url,
    { headers: { "User-Agent": UA, Accept: "application/json" } },
    { timeoutMs: 12_000, maxBytes: 1024 * 1024 },
  );
  const extract = (data.extract ?? "").trim();
  const title = (data.title ?? "").trim();
  if (!title || !extract) return null;
  return {
    lang: data.lang ?? lang,
    title,
    description: data.description ?? "",
    extract,
    url: data.content_urls?.desktop?.page ?? "",
    thumbnail: data.thumbnail?.original ?? "",
  };
}

/** 組裝回覆（test 用）。 */
export function formatWiki(r: WikiResult, maxLen = 400): string {
  const desc = r.description ? `（${r.description}）` : "";
  let extract = r.extract;
  if (extract.length > maxLen) {
    const cut = extract.slice(0, maxLen);
    const idx = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("，"), cut.lastIndexOf("."));
    extract = `${(idx > maxLen * 0.5 ? cut.slice(0, idx + 1) : cut).trim()}…`;
  }
  const lines = [`📖 ${r.title}${desc}`, extract];
  if (r.url) lines.push(r.url);
  return lines.join("\n");
}

/** 依語言關鍵字與設定決定查詢語言。 */
export function langOf(args: string, config: Record<string, string>): string {
  if (/英文|英語|english|\ben\b/i.test(args)) return "en";
  if (/日文|日語|japanese|\bja\b/i.test(args)) return "ja";
  const cfg = (config.lang ?? "").trim();
  return HOSTS[cfg] ? cfg : "zh";
}

/** 從參數取出查詢詞。 */
export function queryOf(args: string): string {
  return args
    .replace(/請幫忙|請幫|幫忙|的/g, " ")
    .replace(/英文|英語|english|日文|日語|japanese|維基|wiki|查一下|查詢|查|一下/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const wikiSkill: SkillDefinition = {
  id: "wiki",
  name: "維基百科",
  description: {
    zh: "查維基百科摘要（免 key；中文/英文/日文）。",
    en: "Look up Wikipedia summaries (no key; zh/en/ja).",
    ja: "ウィキペディア要約を検索（キー不要；中/英/日）。",
  },
  usage: {
    zh: "維基 台灣；維基 英文 black hole；維基 日文 富士山",
    en: "wiki Taiwan; wiki english black hole; wiki japanese Mount Fuji",
    ja: "ウィキ 台湾; ウィキ 英語 black hole; ウィキ 日本語 富士山",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "維基",
  triggerAliases: ["維基百科", "wiki", "wikipedia"],
  fields: [
    {
      key: "lang",
      label: { zh: "預設語言", en: "Default language", ja: "既定の言語" },
      type: "select",
      options: [
        { value: "zh", label: "中文" },
        { value: "en", label: "English" },
        { value: "ja", label: "日本語" },
      ],
      hint: "指令中也可指定（維基 英文 black hole）",
    },
    {
      key: "cacheTtl",
      label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" },
      hint: "預設 24 小時；可填 1h、30m",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "維基百科", ok: true, detail: "Wikipedia REST API（免 key）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const query = queryOf(ctx.args);
    if (!query) {
      await ctx.reply("用法：阿寶請幫忙 維基 台灣（或：維基 英文 black hole）");
      return;
    }
    const lang = langOf(ctx.args, ctx.config);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 1440);
    const cacheKey = `wiki-${lang}-${query}`;

    const hit = readCache<WikiResult | null>(cacheKey, ttlMs);
    let result: WikiResult | null;
    if (hit !== undefined && hit !== null) {
      result = hit;
    } else {
      try {
        result = await fetchWiki(query, lang);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("維基查詢失敗", { query, lang, error: message });
        if (/404/.test(message)) result = null;
        else {
          await ctx.reply("維基百科暫時無法連線，請稍後再試。");
          return;
        }
      }
      if (result) writeCache(cacheKey, result);
      else writeCache(cacheKey, null);
    }

    if (!result) {
      await ctx.reply(`維基百科找不到「${query}」（${lang}）。可以換個詞或指定語言，例如：維基 英文 ${query}`);
      return;
    }
    await ctx.reply(formatWiki(result));
  },
};

export default wikiSkill;
