import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition } from "../types.js";

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
    zh: "即時匯率換算。",
    en: "Real-time currency conversion.",
    ja: "リアルタイム為替換算。",
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
    let base = codes[0];
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
