import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchJson as netFetchJson } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

const API = "https://api.coingecko.com/api/v3/simple/price";

export const COINS: Record<string, { id: string; name: string }> = {
  比特幣: { id: "bitcoin", name: "比特幣" },
  btc: { id: "bitcoin", name: "比特幣" },
  以太幣: { id: "ethereum", name: "以太幣" },
  以太坊: { id: "ethereum", name: "以太坊" },
  eth: { id: "ethereum", name: "以太幣" },
  狗狗幣: { id: "dogecoin", name: "狗狗幣" },
  doge: { id: "dogecoin", name: "狗狗幣" },
  sol: { id: "solana", name: "Solana" },
  索拉納: { id: "solana", name: "Solana" },
  瑞波幣: { id: "ripple", name: "瑞波幣" },
  xrp: { id: "ripple", name: "瑞波幣" },
  bnb: { id: "binancecoin", name: "BNB" },
  幣安幣: { id: "binancecoin", name: "BNB" },
  艾達幣: { id: "cardano", name: "艾達幣" },
  ada: { id: "cardano", name: "艾達幣" },
  雪崩幣: { id: "avalanche-2", name: "雪崩幣" },
  avax: { id: "avalanche-2", name: "雪崩幣" },
  波場幣: { id: "tron", name: "波場幣" },
  trx: { id: "tron", name: "波場幣" },
  萊特幣: { id: "litecoin", name: "萊特幣" },
  ltc: { id: "litecoin", name: "萊特幣" },
  柴犬幣: { id: "shiba-inu", name: "柴犬幣" },
  shib: { id: "shiba-inu", name: "柴犬幣" },
};

export function resolveCoin(args: string): { id: string; name: string } {
  const text = args.toLowerCase();
  const keys = Object.keys(COINS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (text.includes(k.toLowerCase())) return COINS[k];
  }
  return COINS["比特幣"];
}

export interface CoinHit {
  key: string;
  id: string;
  name: string;
}

/** 嚴格找幣：有明確提到才回；找不到回 null（不做預設，供無前綴偵測用）。 */
export function findCoinStrict(text: string): CoinHit | null {
  const lower = text.toLowerCase();
  const keys = Object.keys(COINS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (lower.includes(k.toLowerCase())) return { key: k, ...COINS[k] };
  }
  return null;
}

const CRYPTO_KEYWORDS = ["等於", "值多少", "多少錢", "換算", "折合", "價格", "報價", "現在多少", "漲", "跌", "走勢"];

export interface CryptoConversion {
  coin: CoinHit;
  amount: number | null;
  target: "TWD" | "USD";
}

/**
 * 無前綴幣價意圖偵測（「0.5比特幣值多少」「2 eth 多少台幣」「比特幣漲了」）。
 * 規則：一定要明確提到幣種＋（金額或價格關鍵字）；金額＋明確幣別時目標跟著走，否則預設 TWD。
 */
export function parseCryptoConversion(text: string): CryptoConversion | null {
  const coin = findCoinStrict(text);
  if (!coin) return null;
  const amountMatch = text.match(/(\d+(?:\.\d+)?)/);
  const amount = amountMatch ? Number(amountMatch[1]) : null;
  const hasKeyword = CRYPTO_KEYWORDS.some((k) => text.includes(k));
  const explicitTarget = /台幣|新台幣|TWD|美金|美元|USD/i.test(text);
  const target: "TWD" | "USD" = /美金|美元|USD/i.test(text) ? "USD" : "TWD";
  if (amount !== null && (hasKeyword || explicitTarget)) return { coin, amount, target };
  if (amount === null && hasKeyword) return { coin, amount: null, target };
  return null;
}

interface PriceResp {
  [id: string]: {
    twd?: number;
    usd?: number;
    twd_24h_change?: number;
    usd_24h_change?: number;
  };
}

function fmtMoney(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  const sign = n >= 0 ? "+" : "";
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "＝";
  return ` ${arrow}${sign}${n.toFixed(2)}%`;
}

export interface CoinPrice {
  twd?: number;
  usd?: number;
  twd_24h_change?: number;
  usd_24h_change?: number;
}

/** 組合幣價回覆；有金額時加算總值（純函式，可測試）。 */
export function formatCryptoReply(name: string, p: CoinPrice, amount: number | null): string {
  const base =
    `${name} 即時價格：\nNT$ ${fmtMoney(p.twd, 0)}${fmtPct(p.twd_24h_change)}\n` +
    `US$ ${fmtMoney(p.usd)}${fmtPct(p.usd_24h_change)}（24h）`;
  if (amount === null) return base;
  const twdTotal = p.twd !== undefined ? amount * p.twd : undefined;
  const usdTotal = p.usd !== undefined ? amount * p.usd : undefined;
  return `${base}\n${amount} 顆 ≈ NT$ ${fmtMoney(twdTotal, 0)}（US$ ${fmtMoney(usdTotal)}）`;
}

const cryptoSkill: SkillDefinition = {
  id: "crypto",
  name: "加密貨幣",
  description: {
    zh: "查詢加密貨幣即時價格與 24 小時漲跌（CoinGecko，免 key；也可直接問：0.5比特幣值多少）。",
    en: "Live crypto prices with 24h change (CoinGecko, no key; or just ask the price).",
    ja: "暗号資産の価格と24時間変動を調べます（CoinGecko、キー不要）。",
  },
  usage: {
    zh: "幣價 比特幣",
    en: "crypto bitcoin",
    ja: "幣價 bitcoin",
  },
  category: {
    zh: "金融理財",
    en: "Finance",
    ja: "金融",
  },
  defaultTrigger: "幣價",
  naturalKeywords: ["幣價多少", "幣價如何"],
  triggerAliases: ["crypto", "比特幣", "以太坊", "狗狗幣"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 5 分鐘；可填 1m、60" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await netFetchJson(`${API}?ids=bitcoin&vs_currencies=twd`, undefined, {
        timeoutMs: 15_000,
        maxBytes: 256 * 1024,
      });
      return [{ name: "CoinGecko", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "CoinGecko", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const coin = resolveCoin(ctx.args);
    const amountMatch = ctx.args.match(/(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? Number(amountMatch[1]) : null;
    const ttlMs = parseTtl(ctx.config.cacheTtl, 5);
    const cacheKey = `crypto-${coin.id}`;
    try {
      let data = readCache<PriceResp>(cacheKey, ttlMs);
      if (!data) {
        data = await netFetchJson<PriceResp>(
          `${API}?ids=${coin.id}&vs_currencies=twd,usd&include_24hr_change=true`,
          undefined,
          { timeoutMs: 15_000, maxBytes: 256 * 1024 },
        );
        writeCache(cacheKey, data);
      }
      const p = data[coin.id];
      if (!p || (p.twd === undefined && p.usd === undefined)) throw new Error("查無價格");
      logger.info("幣價查詢", { coin: coin.id, amount });
      await ctx.reply(formatCryptoReply(coin.name, p, amount));
    } catch (error) {
      logger.error("幣價查詢失敗", { error: String(error) });
      await ctx.reply("幣價資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default cryptoSkill;
