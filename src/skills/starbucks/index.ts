import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) (compatible; LineHook/1.0)";
const SOURCE = "https://starbucks.user.today/";
const CACHE_NAME = "starbucks-promos";

interface Promo {
  date: string;
  title: string;
  types: string;
  url: string;
}

async function fetchText(url: string): Promise<string> {
  return netFetchText(
    url,
    { headers: { "User-Agent": UA } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

function parsePromos(html: string): Promo[] {
  const segments = html.split('class="date-num"');
  const promos: Promo[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const date = (seg.match(/>\s*(\d{1,2}\/\d{1,2})/)?.[1] ?? "").trim();
    if (!date) continue;
    const itemRe = /<a\s+href="([^"]+)"[^>]*data-type="([^"]*)"[^>]*data-type2="([^"]*)"[^>]*title="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(seg))) {
      const title = m[4].replace(/&amp;/g, "&").trim();
      if (!title) continue;
      const types = [m[2], m[3]].filter(Boolean).join("／");
      promos.push({ date, title, types, url: m[1] });
    }
  }
  return promos;
}

function mmdd(d: Date): string {
  return `${("0" + (d.getMonth() + 1)).slice(-2)}/${("0" + d.getDate()).slice(-2)}`;
}

async function getPromos(ttlMs: number): Promise<Promo[]> {
  const cached = readCache<Promo[]>(CACHE_NAME, ttlMs);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;
  const promos = parsePromos(await fetchText(SOURCE));
  if (promos.length === 0) throw new Error("無法解析優惠資料");
  writeCache(CACHE_NAME, promos);
  logger.info("星巴克優惠已更新", { count: promos.length });
  return promos;
}

function sortKey(date: string): string {
  const [, m, d] = /(\d{1,2})\/(\d{1,2})/.exec(date) ?? [];
  return `${("0" + m).slice(-2)}-${("0" + d).slice(-2)}`;
}

const starbucksSkill: SkillDefinition = {
  id: "starbucks",
  name: "星巴克優惠",
  description: {
    zh: "查詢星巴克近期優惠。",
    en: "Recent Starbucks promotions.",
    ja: "スターバックスの最新キャンペーン。",
  },
  usage: {
    zh: "星巴克 買一送一",
    en: "starbucks",
    ja: "スターバックス",
  },
  category: {
    zh: "生活消費",
    en: "Shopping",
    ja: "ショッピング",
  },
  defaultTrigger: "星巴克",
  triggerAliases: ["咖啡優惠", "starbucks", "星冰樂"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 6 小時；可填 2h、360" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(SOURCE, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
      return [{ name: "星巴克優惠行事曆", ok: res.ok, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "星巴克優惠行事曆", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 360);
    const args = ctx.args.replace(/請幫忙|請幫|幫忙|幫我|查詢|查一下|優惠|活動|星巴克|咖啡|的/g, " ").trim();
    const keyword = args.replace(/今天|今日|明天|明日|後天|本週|這週|最近|近期/g, "").trim();

    let promos: Promo[];
    try {
      promos = await getPromos(ttlMs);
    } catch (error) {
      logger.error("星巴克優惠查詢失敗", { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply("目前無法取得星巴克優惠資料，請稍後再試。");
      return;
    }

    const now = nowInTz();
    const today = mmdd(now);
    const tomorrow = mmdd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

    let list = promos;
    if (/明天|明日/.test(ctx.args)) list = list.filter((p) => p.date === tomorrow);
    else if (/今天|今日/.test(ctx.args)) list = list.filter((p) => p.date === today);
    else {
      const inWindow = list.filter((p) => {
        const key = sortKey(p.date);
        const start = sortKey(today);
        const end = sortKey(mmdd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)));
        return key >= start && key <= end;
      });
      list = inWindow.length > 0 ? inWindow : list;
    }
    if (keyword) list = list.filter((p) => p.title.includes(keyword) || p.types.includes(keyword));

    const seen = new Map<string, Promo>();
    for (const p of list) {
      const prev = seen.get(p.title);
      if (!prev || sortKey(p.date) < sortKey(prev.date)) seen.set(p.title, p);
    }
    list = [...seen.values()];

    if (list.length === 0) {
      await ctx.reply(`查不到符合的星巴克優惠${keyword ? `（${keyword}）` : ""}。`);
      return;
    }

    const byDate = new Map<string, Promo[]>();
    for (const p of list) {
      const arr = byDate.get(p.date) ?? [];
      arr.push(p);
      byDate.set(p.date, arr);
    }
    const dates = [...byDate.keys()].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).slice(0, 4);
    const blocks = dates.map((date) => {
      const items = (byDate.get(date) ?? []).slice(0, 5).map((p) => `・${p.title}`);
      return `【${date}】\n${items.join("\n")}`;
    });

    await ctx.reply(
      `星巴克近期優惠（共 ${list.length} 則）：\n${blocks.join("\n")}\n` +
      `詳情：https://www.starbucks.com.tw/stores/allevent/`,
    );
  },
};

export default starbucksSkill;
