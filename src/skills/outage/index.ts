import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson, fetchText as netFetchText } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const WATER_URL = "https://web.water.gov.tw/wateroffapi/openData/export/json";
const NEWS_URL = "https://news.google.com/rss/search?q=%E5%81%9C%E9%9B%BB%20%E5%8F%B0%E7%81%A3&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
const TAIPOWER_QUERY = "https://service.taipower.com.tw/nds/ndsWeb/ndft112.aspx";

interface WaterCase {
  案件編號?: string;
  區處?: string;
  案件日期時間?: string;
  恢復日期時間?: string;
  案件類型?: string;
  影響戶數?: string;
  影響縣市?: string;
  影響行政區?: string;
  停水地區?: string;
  停水原因?: string;
  降壓地區?: string;
}

interface NewsItem {
  title: string;
  source: string;
  date: string;
}

const ELECTRIC_RE = /停電|跳電|斷電|沒電|限電|復電|台電/i;

export function filterOutages(cases: WaterCase[], keyword: string): WaterCase[] {
  const list = Array.isArray(cases) ? cases : [];
  const sorted = [...list].sort((a, b) =>
    String(b.案件日期時間 ?? "").localeCompare(String(a.案件日期時間 ?? "")),
  );
  if (!keyword) return sorted;
  return sorted.filter((c) =>
    [c.影響縣市, c.影響行政區, c.停水地區, c.停水原因, c.區處].some((v) => (v ?? "").includes(keyword)),
  );
}

export function formatCase(c: WaterCase): string {
  const where = `${c.影響縣市 ?? ""}${c.影響行政區 ?? ""}`;
  const area = (c.停水地區 ?? "").slice(0, 50);
  const time = `${(c.案件日期時間 ?? "").slice(0, 16)} → ${(c.恢復日期時間 ?? "").slice(0, 16)}`;
  const reason = (c.停水原因 ?? "").replace(/\[|\]/g, "").slice(0, 60);
  const users = c.影響戶數 ? `（影響 ${c.影響戶數} 戶）` : "";
  return `・${where}${users}\n  ${area}\n  ${time}\n  ${reason}`;
}

export function parseNewsRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (re: RegExp): string => {
      const hit = re.exec(block);
      return hit ? hit[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    const rawTitle = pick(/<title>([\s\S]*?)<\/title>/);
    const source = pick(/<source[^>]*>([\s\S]*?)<\/source>/) || "新聞";
    const date = pick(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!rawTitle) continue;
    out.push({ title: rawTitle.replace(/\s*-\s*[^-]+$/, "").trim() || rawTitle, source, date });
  }
  return out;
}

function shortDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => ("0" + n).slice(-2);
  return `${d.getMonth() + 1}/${p(d.getDate())}`;
}

const outageSkill: SkillDefinition = {
  id: "outage",
  name: "停水停電查詢",
  description: {
    zh: "查詢台水停水公告（官方即時資料，免 key）；停電提供台電查詢入口與相關新聞。",
    en: "Water outage notices (official live data, no key); power outage portal links plus news.",
    ja: "断水情報を調べます（公式リアルタイム、キー不要）；停電は問合せ先とニュース。",
  },
  usage: {
    zh: "停水 台北",
    en: "停水 Taipei",
    ja: "停水 台北",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "停水",
  triggerAliases: ["停電", "斷水", "沒水", "outage"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 30 分鐘" },
  ],
  async health(): Promise<SkillHealth[]> {
    const results: SkillHealth[] = [];
    try {
      await netFetchJson(WATER_URL, undefined, { timeoutMs: 15_000, maxBytes: 512 * 1024 });
      results.push({ name: "台水停水公告", ok: true, detail: "OK" });
    } catch {
      results.push({ name: "台水停水公告", ok: false, detail: "連線失敗" });
    }
    return results;
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 30);

    // 停電：台電無公開 API，給查詢入口＋近期相關新聞
    if (ELECTRIC_RE.test(ctx.args)) {
      try {
        const xml = await netFetchText(NEWS_URL, undefined, {
          timeoutMs: 15_000,
          maxBytes: 512 * 1024,
        });
        const news = parseNewsRss(xml).slice(0, 5);
        const lines = news.map((n) => `・${n.title}（${n.source}${n.date ? ` ${shortDate(n.date)}` : ""}）`);
        await ctx.reply(
          `停電請先確認：\n・台電停電查詢（需地址/電號）：${TAIPOWER_QUERY}\n・客服專線：1911\n近期相關消息：\n${lines.length > 0 ? lines.join("\n") : "（暫無）"}`,
        );
      } catch (error) {
        logger.warn("停電新聞讀取失敗", { error: String(error) });
        await ctx.reply(
          `停電請先確認：\n・台電停電查詢（需地址/電號）：${TAIPOWER_QUERY}\n・客服專線：1911`,
        );
      }
      return;
    }

    // 停水：台水官方 JSON
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|停水|斷水|沒水|公告|的/g, " ")
      .trim();
    try {
      let cases = readCache<WaterCase[]>("outage-water", ttlMs);
      if (!cases) {
        cases = await netFetchJson<WaterCase[]>(WATER_URL, undefined, {
          timeoutMs: 15_000,
          maxBytes: 4 * 1024 * 1024,
        });
        writeCache("outage-water", cases);
      }
      const hits = filterOutages(cases, keyword).slice(0, 5);
      if (hits.length === 0) {
        await ctx.reply(
          keyword
            ? `目前查無「${keyword}」的停水公告。\n完整查詢：https://web.water.gov.tw/wateroffmap`
            : "目前無停水公告。\n完整查詢：https://web.water.gov.tw/wateroffmap",
        );
        return;
      }
      logger.info("停水查詢", { keyword, count: hits.length });
      await ctx.reply(`停水公告${keyword ? `（${keyword}）` : ""}：\n${hits.map(formatCase).join("\n")}`);
    } catch (error) {
      logger.error("停水查詢失敗", { error: String(error) });
      await ctx.reply("停水資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default outageSkill;
