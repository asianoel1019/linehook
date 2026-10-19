import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import type { SkillContext, SkillDefinition } from "@lw/skills/types";

const API = "https://open.er-api.com/v6/latest";
const CACHE_NAME = "exchange-rate";

interface RatesResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc: string;
}

const CURRENCIES: Record<string, string> = {
  TWD: "台幣",
  台幣: "TWD",
  新台幣: "TWD",
  USD: "美金",
  美金: "USD",
  美元: "USD",
  JPY: "日幣",
  日幣: "JPY",
  日圓: "JPY",
  日元: "JPY",
  CNY: "人民幣",
  人民幣: "CNY",
  EUR: "歐元",
  歐元: "EUR",
  KRW: "韓元",
  韓元: "KRW",
  HKD: "港幣",
  港幣: "HKD",
  GBP: "英鎊",
  英鎊: "GBP",
  SGD: "新加坡幣",
  THB: "泰銖",
  AUD: "澳幣",
  CAD: "加幣",
};

export function toCode(token: string): string | undefined {
  const key = token.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(key)) return key;
  return CURRENCIES[token.trim()];
}

/** 無前綴偵測只認這些代碼，避免亂碼觸發對外查詢。 */
const KNOWN_CODES = new Set<string>(Object.values(CURRENCIES));

const CONVERT_KEYWORDS = ["等於", "換算", "換成", "折合", "值多少", "多少錢", "等值", "兌換", "換匯"];

export interface ConversionRequest {
  amount: number;
  from: string;
  to: string;
}

/** 解析金額（含「萬/千」中文單位）；找不到回 null。 */
function parseAmount(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(萬|千)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "萬") return n * 10000;
  if (m[2] === "千") return n * 1000;
  return n;
}

/**
 * 無前綴換算意圖偵測（「100美金等於台幣」「1萬日幣換算台幣」）。
 * 保守規則：≥2 種幣別＋（有金額或有關鍵字）；或 1 種幣別＋金額＋關鍵字（目標預設 TWD）。
 * 命中回正規化請求（轉成 args 可直接餵給 run），否則回 null。
 */
export function parseConversion(text: string): ConversionRequest | null {
  const hits: Array<{ code: string; index: number }> = [];
  const push = (code: string, index: number): void => {
    if (index < 0 || hits.some((h) => h.code === code)) return;
    hits.push({ code, index });
  };
  const names = Object.keys(CURRENCIES)
    .filter((k) => !/^[A-Z]{3}$/.test(k))
    .sort((a, b) => b.length - a.length);
  for (const n of names) push(CURRENCIES[n], text.indexOf(n));
  for (const m of text.toUpperCase().matchAll(/\b[A-Z]{3}\b/g)) {
    if (KNOWN_CODES.has(m[0])) push(m[0], m.index ?? -1);
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.index - b.index);
  const amount = parseAmount(text);
  const hasKeyword = CONVERT_KEYWORDS.some((k) => text.includes(k));
  if (hits.length >= 2) {
    if (amount === null && !hasKeyword) return null;
    return { amount: amount ?? 1, from: hits[0].code, to: hits[1].code };
  }
  if (amount === null || !hasKeyword) return null;
  if (hits[0].code === "TWD") return null;
  return { amount, from: hits[0].code, to: "TWD" };
}

/** 轉成 run() 吃得懂的參數字串（「100 USD TWD」）。 */
export function conversionArgs(req: ConversionRequest): string {
  return `${req.amount} ${req.from} ${req.to}`;
}

export async function getRates(base: string, ttlMs: number): Promise<RatesResponse> {
  const cacheKey = `${CACHE_NAME}-${base}`;
  const cached = readCache<RatesResponse>(cacheKey, ttlMs);
  if (cached && cached.rates) return cached;
  const res = await fetch(`${API}/${base}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`匯率來源失敗（HTTP ${res.status}）`);
  const data = (await res.json()) as RatesResponse;
  if (data.result !== "success" || !data.rates) throw new Error("匯率資料格式錯誤");
  writeCache(cacheKey, data);
  return data;
}

const exchangeSkill: SkillDefinition = {
  id: "exchange-rate",
  name: "匯率換算",
  description: {
    zh: "即時匯率換算（也可直接問：100美金等於台幣）。",
    en: "Real-time currency conversion (or just ask: 100 USD to TWD).",
    ja: "リアルタイム為替換算（「100ドルは何台湾ドル？」のような聞き方も可）。",
  },
  usage: {
    zh: "匯率 1000 日幣 台幣",
    en: "rate 1000 JPY TWD",
    ja: "為替 1000 日本円 台湾ドル",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "匯率",
  naturalKeywords: ["匯率多少", "匯率如何", "現在匯率", "匯率"],
  triggerAliases: ["換算", "匯率換算"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；可填 30（分鐘）、30m、2h、90s" },
    {
      key: "defaultCurrency",
      label: "預設目標幣別",
      hint: "只填一種幣別時，預設換成此幣別；預設 TWD（台幣）",
    },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);

    // 找金額
    const amountMatch = ctx.args.match(/(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? Number(amountMatch[1]) : 1;

    // 找幣別：移除數字後，取可辨識幣別
    const words = ctx.args
      .replace(/[\d.,]+/g, " ")
      .split(/[\s的到至去>＝=]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const codes: string[] = [];
    for (const w of words) {
      const code = toCode(w);
      if (code && !codes.includes(code)) codes.push(code);
      if (codes.length >= 2) break;
    }

    // 預設目標幣別（可在技能設定調整，預設 TWD）
    const defaultCurrency = toCode(ctx.config.defaultCurrency || "") || "TWD";

    if (codes.length === 0) {
      await ctx.reply("用法：匯率 1000 日幣 台幣（或 匯率 美金 100）");
      return;
    }

    // 只填一種幣別時，目標預設為設定的預設幣別
    const base = codes[0];
    let target = codes[1];
    if (!target) {
      if (base === defaultCurrency) {
        await ctx.reply(`只填了一種幣別（${base}），且與預設目標幣別相同，請再指定另一種幣別。`);
        return;
      }
      target = defaultCurrency;
    }
    try {
      const data = await getRates(base, ttlMs);
      const rate = data.rates[target];
      if (!Number.isFinite(rate)) {
        await ctx.reply(`查不到 ${base} → ${target} 的匯率。`);
        return;
      }
      const converted = amount * rate;
      const updated = (data.time_last_update_utc || "").replace(" +0000", " UTC");
      await ctx.reply(
        `${amount} ${base} = ${converted.toFixed(2)} ${target}\n匯率 1 ${base} ≈ ${rate.toFixed(4)} ${target}（更新：${updated}）`,
      );
      logger.info("匯率換算", { base, target, amount });
    } catch (error) {
      logger.error("匯率換算失敗", { error: String(error) });
      await ctx.reply("匯率來源目前無法使用，請稍後再試。");
    }
  },
};

export default exchangeSkill;
