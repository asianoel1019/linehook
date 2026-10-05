import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

interface CouponItem {
  name?: string;
  count?: number;
}

interface RawCoupon {
  coupon_code?: number | string;
  name?: string;
  price?: number;
  items?: CouponItem[];
  start_date?: string;
  end_date?: string;
}

interface Coupon {
  code: string;
  name: string;
  price: number;
  items: CouponItem[];
  start: string;
  end: string;
}

interface Source {
  name: string;
  url: string;
}

const SOURCES: Source[] = [
  { name: "KCouper", url: "https://winedays.github.io/KCouper/coupon.js" },
  { name: "肯德基優惠碼", url: "https://kfc.izo.tw/" },
  { name: "Talk 優惠", url: "https://info.talk.tw/kfc-coupon/" },
  { name: "Lifi", url: "https://www.lifi.com.tw/post/invkfccoupon" },
];

const health: Record<string, { ok: boolean; detail: string; count: number; at: number }> = {};
const CACHE_NAME = "kfc-coupons";

function setHealth(name: string, ok: boolean, detail: string, count = 0): void {
  health[name] = { ok, detail, count, at: Date.now() };
}

async function fetchText(url: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return netFetchText(
    url,
    {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" },
    },
    { timeoutMs: 15_000, maxBytes },
  );
}

/** 來源一：KCouper 的 coupon.js（結構化 JSON；檔案已超過 2MB，需放寬上限）。 */
async function loadFromKCouper(url: string): Promise<Coupon[]> {
  const text = await fetchText(url, 8 * 1024 * 1024);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("找不到資料");
  const data = JSON.parse(text.slice(start, end + 1)) as {
    coupon_by_code?: Record<string, RawCoupon>;
  };
  const byCode = data.coupon_by_code ?? {};
  const coupons: Coupon[] = [];
  for (const raw of Object.values(byCode)) {
    const price = Number(raw.price);
    const code = raw.coupon_code;
    if (!code || !Number.isFinite(price)) continue;
    coupons.push({
      code: String(code),
      name: String(raw.name ?? ""),
      price,
      items: raw.items ?? [],
      start: raw.start_date ?? "",
      end: raw.end_date ?? "",
    });
  }
  if (coupons.length === 0) throw new Error("資料為空");
  return coupons;
}

/** 來源二（備援）：從 HTML 以正則擷取「優惠代碼 code」與價格。 */
async function loadFromHtml(url: string): Promise<Coupon[]> {
  const text = await fetchText(url);
  const coupons: Coupon[] = [];
  const seen = new Set<string>();
  // 擷取形如 代碼 15730 或 /coupons/15730，附近若有 $價格 則配對
  const codeRe = /(?:優惠代碼|coupons\/|代碼[：:\s]*)(\d{4,6})/g;
  let match: RegExpExecArray | null;
  while ((match = codeRe.exec(text))) {
    const code = match[1];
    if (seen.has(code)) continue;
    const window = text.slice(match.index, match.index + 400);
    const priceMatch = window.match(/\$\s*(\d{2,4})|(\d{2,4})\s*元/);
    const price = priceMatch ? Number(priceMatch[1] ?? priceMatch[2]) : NaN;
    if (!Number.isFinite(price)) continue;
    seen.add(code);
    const nameMatch = window.match(/([\u4e00-\u9fff][^<>{}|]{2,30})/);
    coupons.push({
      code,
      name: nameMatch ? nameMatch[1].trim() : `優惠代碼 ${code}`,
      price,
      items: [],
      start: "",
      end: "",
    });
  }
  if (coupons.length === 0) throw new Error("無法解析優惠資料");
  return coupons;
}

async function getCoupons(ttlMs: number): Promise<{ coupons: Coupon[]; source: string }> {
  const cached = readCache<{ coupons: Coupon[]; source: string }>(CACHE_NAME, ttlMs);
  if (cached && Array.isArray(cached.coupons) && cached.coupons.length > 0) {
    return cached;
  }
  let lastError = "";
  for (const source of SOURCES) {
    try {
      const coupons =
        source.name === "KCouper"
          ? await loadFromKCouper(source.url)
          : await loadFromHtml(source.url);
      setHealth(source.name, true, `可用（${coupons.length} 筆）`, coupons.length);
      const result = { coupons, source: source.name };
      writeCache(CACHE_NAME, result);
      logger.info("肯德基優惠資料已載入", { source: source.name, count: coupons.length });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      setHealth(source.name, false, `失效：${lastError}`);
      logger.warn("肯德基優惠來源失效，改用備援", { source: source.name, error: lastError });
    }
  }
  throw new Error(`所有來源皆失效：${lastError}`);
}

function summarizeItems(items: CouponItem[]): string {
  const parts = items
    .filter((item) => item.name)
    .map((item) => (item.count && item.count > 1 ? `${item.name}×${item.count}` : String(item.name)));
  return parts.join("、");
}

function formatReply(target: number, coupons: Coupon[], source: string): string {
  const low = target * 0.7;
  const high = target * 1.3;
  const matches = coupons
    .filter((c) => c.price >= low && c.price <= high)
    .sort((a, b) => Math.abs(a.price - target) - Math.abs(b.price - target))
    .slice(0, 5);

  if (matches.length === 0) {
    return `找不到 ${Math.round(low)}～${Math.round(high)} 元的肯德基優惠代碼。`;
  }
  const lines = matches.map((c) => {
    const items = summarizeItems(c.items);
    const content = items ? `\n   ${items}` : "";
    return `【${c.code}】$${c.price} ${c.name.split("-").slice(1).join("-") || c.name}${content}`;
  });
  return `肯德基 $${Math.round(low)}～${Math.round(high)} 的優惠代碼（資料來源：${source}）：\n${lines.join("\n")}`;
}

const kfcSkill: SkillDefinition = {
  id: "kfc-coupon",
  name: "肯德基優惠",
  description: {
    zh: "查詢肯德基優惠代碼。",
    en: "KFC coupon codes.",
    ja: "KFC のクーポンコード。",
  },
  usage: {
    zh: "肯德基 100",
    en: "kfc 100",
    ja: "KFC 100",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "肯德基",
  triggerAliases: ["肯德雞", "肯德", "kfc", "KFC"],
  fields: [
    {
      key: "cacheTtl",
      label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" },
      hint: "預設 60 分鐘；可填 30（分鐘）、30m、2h、90s",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    const results = await Promise.all(
      SOURCES.map(async (s): Promise<SkillHealth> => {
        try {
          const res = await fetch(s.url, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0 (compatible; LineHook/1.0)" },
            signal: AbortSignal.timeout(15_000),
          });
          const ok = res.ok;
          setHealth(s.name, ok, ok ? `可用（HTTP ${res.status}）` : `失效（HTTP ${res.status}）`);
          return { name: s.name, ok, detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status}（失效）` };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setHealth(s.name, false, `失效：${detail}`);
          return { name: s.name, ok: false, detail: "連線失敗" };
        }
      }),
    );
    return results;
  },
  async run(ctx: SkillContext): Promise<void> {
    const match = ctx.args.match(/(\d{2,4})/);
    if (!match) {
      await ctx.reply("請提供價格，例如：阿寶請幫忙 肯德基 100");
      return;
    }
    const target = Number(match[1]);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);

    try {
      const { coupons, source } = await getCoupons(ttlMs);
      await ctx.reply(formatReply(target, coupons, source));
    } catch (error) {
      logger.error("肯德基優惠查詢失敗", { error: String(error) });
      await ctx.reply("目前所有優惠資料來源皆無法使用，請稍後再試。");
    }
  },
};

export default kfcSkill;
