import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";
/** 萌典「教育部國語辭典」公開 JSON（免 key）。 */
const API = "https://www.moedict.tw/uni";

interface MoeDefinition {
  def?: string;
  type?: string;
  quote?: string[];
  link?: string[];
}

interface MoeHeteronym {
  bopomofo?: string;
  pinyin?: string;
  definitions?: MoeDefinition[];
}

interface MoeEntry {
  title?: string;
  heteronyms?: MoeHeteronym[];
}

export interface DictSense {
  /** 注音符號（第一種讀音）。 */
  bopomofo: string;
  /** 漢語拼音。 */
  pinyin: string;
  type: string;
  def: string;
  quotes: string[];
}

/** 解析萌典 uni JSON → 義項清單；沒有 heteronyms 回空陣列。 */
export function parseEntry(data: unknown): DictSense[] {
  const het = (data as MoeEntry | null)?.heteronyms;
  if (!Array.isArray(het)) return [];
  const out: DictSense[] = [];
  for (const h of het) {
    const bopomofo = typeof h?.bopomofo === "string" ? h.bopomofo : "";
    const pinyin = typeof h?.pinyin === "string" ? h.pinyin : "";
    for (const d of Array.isArray(h?.definitions) ? h.definitions : []) {
      const def = typeof d?.def === "string" ? d.def.trim() : "";
      if (!def) continue;
      out.push({
        bopomofo,
        pinyin,
        type: typeof d?.type === "string" ? d.type : "",
        def,
        quotes: Array.isArray(d?.quote) ? d.quote.filter((q): q is string => typeof q === "string").slice(0, 1) : [],
      });
    }
  }
  return out.slice(0, 6);
}

/** 組裝回覆文字（test 用，也供 run 使用）。 */
export function formatEntry(word: string, senses: DictSense[]): string {
  if (senses.length === 0) return `查無「${word}」的解釋（教育部國語辭典）。`;
  const first = senses[0];
  const pron = first.bopomofo
    ? `（注音 ${first.bopomofo}${first.pinyin ? `／拼音 ${first.pinyin}` : ""}）`
    : first.pinyin
      ? `（拼音 ${first.pinyin}）`
      : "";
  const lines: string[] = [`${word}${pron}`];
  for (const [i, s] of senses.entries()) {
    const type = s.type ? `〔${s.type}〕` : "";
    const extraBopo = i > 0 && s.bopomofo && s.bopomofo !== first.bopomofo ? `（注音 ${s.bopomofo}）` : "";
    lines.push(`${i + 1}. ${type}${extraBopo}${s.def}`);
    if (s.quotes.length > 0) lines.push(`   例：${s.quotes[0]}`);
  }
  lines.push("— 教育部國語辭典（萌典）");
  return lines.join("\n");
}

async function fetchEntry(word: string): Promise<unknown> {
  const url = `${API}/${encodeURIComponent(word)}`;
  return netFetchJson<unknown>(
    url,
    { headers: { "User-Agent": UA, Accept: "application/json" } },
    { timeoutMs: 12_000, maxBytes: 1024 * 1024 },
  );
}

const dictSkill: SkillDefinition = {
  id: "dict",
  name: "辭典",
  description: {
    zh: "查教育部國語辭典（萌典，免 key）：解釋、注音、拼音、例句。",
    en: "Look up the Moe Mandarin dictionary (MoeDict, no key): definitions, bopomofo, pinyin, quotes.",
    ja: "教育部国語辞典（萌典、キー不要）を検索：解説・注音・拼音・例文。",
  },
  usage: {
    zh: "辭典 台灣；辭典 朝三暮四",
    en: "dict Taiwan; dict idiom",
    ja: "辞典 台湾; 辞典 故事",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "辭典",
  triggerAliases: ["查詞", "萌典", "國語辭典", "dict", "注音"],
  fields: [
    {
      key: "cacheTtl",
      label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" },
      hint: "預設 24 小時；可填 1h、30m",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "萌典辭典", ok: true, detail: "moedict.tw（免 key）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const word = ctx.args
      .replace(/請幫忙|請幫|幫忙|查|查詢|辭典|查詞|萌典|國語辭典|dict|注音|的意思|是啥|是什麼|的/g, " ")
      .trim();
    if (!word) {
      await ctx.reply("用法：阿寶請幫忙 辭典 台灣（也可查成語：朝三暮四）");
      return;
    }

    const ttlMs = parseTtl(ctx.config.cacheTtl, 1440);
    const cacheKey = `dict-${word}`;
    const hit = readCache<unknown>(cacheKey, ttlMs);
    let data: unknown = hit;
    if (data === undefined || data === null) {
      try {
        data = await fetchEntry(word);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("萌典查詢失敗", { word, error: message });
        if (/404/.test(message)) {
          await ctx.reply(`查無「${word}」的解釋（教育部國語辭典）。`);
          return;
        }
        await ctx.reply("萌典暫時無法連線，請稍後再試。");
        return;
      }
      writeCache(cacheKey, data);
    }

    const senses = parseEntry(data);
    if (senses.length === 0) {
      await ctx.reply(`查無「${word}」的解釋（教育部國語辭典）。`);
      return;
    }
    await ctx.reply(formatEntry(word, senses));
  },
};

export default dictSkill;
