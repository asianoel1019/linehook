import { logger } from "@lw/logger";
import { parseTtl } from "@lw/skills/cache";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";
import { fetchMcdonaldPromos } from "@lw/skills/mcdonald";
import { fetchBurgerDeals } from "@lw/skills/burger-coupon";
import { fetchStarbucksPromos } from "@lw/skills/starbucks";
import { fetchKfcCoupons } from "@lw/skills/kfc-coupon";
import { fetchStorePromos } from "@lw/skills/promo";

export interface DealItem {
  brand: string;
  title: string;
  detail: string;
  price?: number;
}

export interface DealFilter {
  brands: string[] | null;
  price: number | null;
  keyword: string;
}

const BRAND_ORDER = ["麥當勞", "肯德基", "漢堡王", "摩斯漢堡", "星巴克", "全聯", "家樂福"];

/**
 * 從文字判斷鎖定哪些品牌；回 null 表示全部。
 * 「漢堡」這種泛稱沒指名時，涵蓋四家漢堡速食。
 */
export function detectBrands(text: string): string[] | null {
  const found = new Set<string>();
  if (/麥當勞|麥記|mcdonald/i.test(text) || /\bmcd\b/i.test(text)) found.add("麥當勞");
  if (/肯德基|肯德|kfc/i.test(text)) found.add("肯德基");
  if (/漢堡王|華堡|burgerking/i.test(text) || /\bbk\b/i.test(text)) found.add("漢堡王");
  if (/摩斯|mosburger/i.test(text) || /\bmos\b/i.test(text)) found.add("摩斯漢堡");
  if (/星巴克|星冰樂|starbucks|咖啡/i.test(text)) found.add("星巴克");
  if (/全聯/i.test(text)) found.add("全聯");
  if (/家樂福|萬家福/i.test(text)) found.add("家樂福");
  if (/漢堡/i.test(text) && found.size === 0) {
    found.add("麥當勞");
    found.add("肯德基");
    found.add("漢堡王");
    found.add("摩斯漢堡");
  }
  return found.size > 0 ? [...found] : null;
}

/** 去掉品牌字、噪音字與金額，留下真正的關鍵字。 */
export function extractKeyword(args: string): string {
  return args
    .replace(
      /請幫忙|請幫|幫忙|查詢|查一下|優惠|特價|活動|促銷|麥當勞|麥記|肯德基|肯德|漢堡王|華堡|摩斯|星巴克|星冰樂|咖啡|全聯|家樂福|萬家福|mcdonald|mosburger|burgerking|starbucks|mcd|kfc|\bbk\b|\bmos\b|\d{2,4}/gi,
      " ",
    )
    .replace(/[\s的]+/g, " ")
    .trim();
}

/** 品牌 → 價格（±30%）→ 關鍵字依序過濾（純函式，可測試）。 */
export function filterDeals(items: DealItem[], filter: DealFilter): DealItem[] {
  let list = items;
  if (filter.brands) {
    const set = new Set(filter.brands);
    list = list.filter((d) => set.has(d.brand));
  }
  if (filter.price !== null) {
    const target = filter.price;
    const low = target * 0.7;
    const high = target * 1.3;
    list = list
      .filter((d) => d.price !== undefined && d.price >= low && d.price <= high)
      .sort((a, b) => Math.abs((a.price ?? 0) - target) - Math.abs((b.price ?? 0) - target));
  }
  if (filter.keyword) {
    list = list.filter((d) => d.title.includes(filter.keyword) || d.detail.includes(filter.keyword));
  }
  return list;
}

export function formatDeals(title: string, list: DealItem[], hint: string): string {
  const lines = list.map(
    (d) => `【${d.brand}】${d.title}${d.detail ? `\n  ${d.detail.slice(0, 80)}` : ""}`,
  );
  return `${title}\n${lines.join("\n")}${hint ? `\n${hint}` : ""}`;
}

function kfcItemsSummary(items: Array<{ name?: string; count?: number }>): string {
  return items
    .filter((i) => i.name)
    .map((i) => (i.count && i.count > 1 ? `${i.name}×${i.count}` : String(i.name)))
    .join("、");
}

function kfcShortName(name: string): string {
  return name.split("-").slice(1).join("-") || name;
}

async function collectAll(ttlMs: number): Promise<{ items: DealItem[]; failed: string[] }> {
  const jobs: Array<{ brands: string[]; load: () => Promise<DealItem[]> }> = [
    {
      brands: ["麥當勞"],
      load: async () =>
        (await fetchMcdonaldPromos(ttlMs)).map((p) => ({
          brand: "麥當勞",
          title: p.name,
          detail: [p.offer, p.period].filter(Boolean).join(" "),
          price: p.price,
        })),
    },
    {
      brands: ["肯德基"],
      load: async () =>
        (await fetchKfcCoupons(ttlMs)).map((c) => ({
          brand: "肯德基",
          title: `【${c.code}】$${c.price} ${kfcShortName(c.name)}`,
          detail: kfcItemsSummary(c.items),
          price: c.price,
        })),
    },
    {
      brands: ["漢堡王", "摩斯漢堡"],
      load: async () =>
        (await fetchBurgerDeals(ttlMs)).map((d) => ({
          brand: d.brand,
          title: d.title,
          detail: `$${d.price}`,
          price: Number(d.price),
        })),
    },
    {
      brands: ["星巴克"],
      load: async () =>
        (await fetchStarbucksPromos(ttlMs)).map((p) => ({
          brand: "星巴克",
          title: p.title,
          detail: `${p.date}${p.types ? ` ${p.types}` : ""}`,
        })),
    },
    {
      brands: ["全聯", "家樂福"],
      load: async () =>
        (await fetchStorePromos(ttlMs)).map((p) => ({
          brand: p.store,
          title: p.title,
          detail: p.date,
        })),
    },
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j.load()));
  const items: DealItem[] = [];
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else {
      failed.push(...jobs[i].brands);
      logger.warn("優惠聚合部分來源失敗", {
        brands: jobs[i].brands,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  return { items, failed };
}

const dealsSkill: SkillDefinition = {
  id: "deals",
  name: "優惠速覽",
  description: {
    zh: "一次掃過麥當勞、肯德基、漢堡王、摩斯、星巴克、全聯、家樂福當期優惠。",
    en: "One-shot deals across fast food, coffee and supermarkets.",
    ja: "ファストフード・コーヒー・スーパーのお得情報を一括検索。",
  },
  usage: {
    zh: "優惠（速覽）或 優惠 漢堡／優惠 100",
    en: "deals or deals burger",
    ja: "優惠",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "優惠",
  triggerAliases: ["好康"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；各品牌沿用自己的快取" },
  ],
  async health(): Promise<SkillHealth[]> {
    // 本體只是聚合（不直接抓網），各品牌來源健康看各自技能的 health。
    return [{ name: "優惠聚合", ok: true, detail: `涵蓋：${BRAND_ORDER.join("・")}` }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const priceMatch = ctx.args.match(/(\d{2,4})/);
    const price = priceMatch ? Number(priceMatch[1]) : null;
    const brands = detectBrands(ctx.text);
    const keyword = extractKeyword(ctx.args);
    const { items, failed } = await collectAll(ttlMs);
    if (items.length === 0) {
      logger.error("優惠聚合全部來源失敗", {});
      await ctx.reply("各家優惠來源都暫時不可用，請稍後再試。");
      return;
    }
    const failNote = failed.length > 0 ? `（${failed.join("、")}暫時不可用）` : "";
    if (!brands && price === null && !keyword) {
      const top: DealItem[] = [];
      for (const b of BRAND_ORDER) {
        const first = items.find((d) => d.brand === b);
        if (first) top.push(first);
      }
      logger.info("優惠速覽", { count: top.length, failed: failed.length });
      await ctx.reply(
        formatDeals(`今日優惠速覽${failNote}：`, top, "查更多：麥當勞／肯德基 100、星巴克 買一送一、促銷 全聯"),
      );
      return;
    }
    const filtered = filterDeals(items, { brands, price, keyword });
    if (filtered.length === 0) {
      const label = [brands ? brands.join("・") : "", price !== null ? `$${price}±30%` : "", keyword ? `「${keyword}」` : ""]
        .filter(Boolean)
        .join(" ");
      await ctx.reply(`找不到${label}相關優惠${failNote}。`);
      return;
    }
    const label = [keyword ? `「${keyword}」` : "", brands ? brands.join("・") : "", price !== null ? `$${price}±30%` : ""]
      .filter(Boolean)
      .join(" ");
    logger.info("優惠聚合查詢", { label, count: filtered.length });
    await ctx.reply(formatDeals(`${label}相關優惠（${filtered.length}）${failNote}：`, filtered.slice(0, 8), ""));
  },
};

export default dealsSkill;
