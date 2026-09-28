import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const GOOGLE = "https://translate.googleapis.com/translate_a/single";

const LANG_WORDS: Array<{ words: string[]; code: string }> = [
  { words: ["英文", "英語", "english", "en"], code: "en" },
  { words: ["日文", "日本語", "日語", "japanese", "jp", "ja"], code: "ja" },
  { words: ["韓文", "韓語", "korean", "kr", "ko"], code: "ko" },
  { words: ["簡體", "簡體中文", "簡中", "zh-cn"], code: "zh-CN" },
  { words: ["繁體", "繁體中文", "繁中", "中文", "國語", "zh-tw"], code: "zh-TW" },
  { words: ["法文", "法語", "french", "fr"], code: "fr" },
  { words: ["德文", "德語", "german", "de"], code: "de" },
  { words: ["西班牙文", "西班牙語", "spanish", "es"], code: "es" },
  { words: ["義大利文", "義語", "italian", "it"], code: "it" },
  { words: ["俄文", "俄語", "russian", "ru"], code: "ru" },
  { words: ["越南文", "越南語", "vietnamese", "vi"], code: "vi" },
  { words: ["泰文", "泰語", "thai", "th"], code: "th" },
  { words: ["印尼文", "印尼語", "indonesian", "id"], code: "id" },
  { words: ["阿拉伯文", "阿拉伯語", "arabic", "ar"], code: "ar" },
];

const LANG_LABEL: Record<string, string> = {
  en: "英文", ja: "日文", ko: "韓文", "zh-TW": "繁體中文", "zh-CN": "簡體中文",
  fr: "法文", de: "德文", es: "西班牙文", it: "義大利文", ru: "俄文",
  vi: "越南文", th: "泰文", id: "印尼文", ar: "阿拉伯文",
};

interface GoogleSeg {
  0?: string;
}

async function viaGoogle(text: string, to: string): Promise<{ text: string; from: string }> {
  const url = `${GOOGLE}?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as [GoogleSeg[], unknown, string];
  const translated = (data[0] ?? []).map((seg) => seg?.[0] ?? "").join("");
  if (!translated) throw new Error("無翻譯結果");
  return { text: translated, from: typeof data[2] === "string" ? data[2] : "auto" };
}

async function viaMyMemory(text: string, to: string, from: string): Promise<{ text: string; from: string }> {
  const src = from && from !== "auto" ? from : "zh-TW";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(to)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { responseData?: { translatedText?: string } };
  const translated = data.responseData?.translatedText ?? "";
  if (!translated || /MYMEMORY WARNING/i.test(translated)) throw new Error("無翻譯結果");
  return { text: translated, from: src };
}

function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

const translateSkill: SkillDefinition = {
  id: "translate",
  name: "翻譯",
  description: {
    zh: "翻譯文字。",
    en: "Translate text.",
    ja: "テキストを翻訳します。",
  },
  usage: {
    zh: "翻譯 你好 英文",
    en: "translate hello Japanese",
    ja: "翻訳 こんにちは 英語",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "翻譯",
  triggerAliases: ["翻", "translate", "翻成", "譯"],
  fields: [],
  async health(): Promise<SkillHealth[]> {
    try {
      await viaGoogle("你好", "en");
      return [{ name: "Google 翻譯", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "Google 翻譯", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    let rest = ctx.args.replace(/請幫忙|請幫|幫忙|查詢|查一下|幫我|翻譯|翻成|翻|譯成|譯|的|成/g, " ");
    let to = "";
    for (const lang of LANG_WORDS) {
      const hit = lang.words.find((w) => new RegExp(w, "i").test(rest));
      if (hit) {
        to = lang.code;
        rest = rest.replace(new RegExp(hit, "ig"), " ");
        break;
      }
    }
    const text = rest.replace(/\s+/g, " ").trim();
    if (!text) {
      await ctx.reply("請提供要翻譯的內容與目標語言，例如：阿寶請幫忙 翻譯 你好 英文");
      return;
    }
    if (!to) to = hasCjk(text) ? "en" : "zh-TW";

    let result: { text: string; from: string } | null = null;
    let err = "";
    for (const fn of [() => viaGoogle(text, to), () => viaMyMemory(text, to, "auto")]) {
      try {
        result = await fn();
        break;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
    }
    if (!result) {
      logger.warn("翻譯失敗", { to, err });
      await ctx.reply("翻譯服務目前無法使用，請稍後再試。");
      return;
    }
    const label = LANG_LABEL[to] ?? to;
    logger.info("翻譯", { from: result.from, to, len: text.length });
    await ctx.reply(`翻譯（${result.from} → ${label}）：\n${result.text}`);
  },
};

export default translateSkill;
