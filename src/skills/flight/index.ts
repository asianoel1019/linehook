import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const UA = "Mozilla/5.0 (compatible; LineHook/1.0)";

interface Offer {
  price: number;
  currency: string;
  date: string;
  airline: string;
  transfers: number;
}

const CITY_IATA: Record<string, string> = {
  台北: "TPE", 臺北: "TPE", 桃園: "TPE", 松山: "TSA", 高雄: "KHH", 台中: "RMQ", 臺中: "RMQ",
  東京: "NRT", 成田: "NRT", 羽田: "HND", 大阪: "KIX", 名古屋: "NGO", 福岡: "FUK", 沖繩: "OKA", 札幌: "CTS",
  首爾: "ICN", 釜山: "PUS", 香港: "HKG", 澳門: "MFM",
  上海: "PVG", 北京: "PEK", 廣州: "CAN", 深圳: "SZX", 成都: "CTU", 廈門: "XMN",
  曼谷: "BKK", 清邁: "CNX", 普吉: "HKT", 新加坡: "SIN", 吉隆坡: "KUL", 檳城: "PEN",
  馬尼拉: "MNL", 宿霧: "CEB", 河內: "HAN", 胡志明: "SGN", 峴港: "DAD",
  峇里島: "DPS", 雅加達: "CGK", 倫敦: "LHR", 巴黎: "CDG", 阿姆斯特丹: "AMS", 法蘭克福: "FRA", 羅馬: "FCO",
  雪梨: "SYD", 墨爾本: "MEL", 布里斯本: "BNE", 洛杉磯: "LAX", 舊金山: "SFO", 紐約: "JFK", 西雅圖: "SEA", 溫哥華: "YVR", 杜拜: "DXB",
};

function resolveAirports(text: string): string[] {
  const codes: string[] = [];
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (!codes.includes(m[1])) codes.push(m[1]);
  }
  if (codes.length >= 2) return codes.slice(0, 2);
  for (const [name, code] of Object.entries(CITY_IATA)) {
    if (text.includes(name) && !codes.includes(code)) codes.push(code);
  }
  return codes.slice(0, 2);
}

/** 解析出航班的年月區間（回傳 {year, month}）。 */
function parseMonth(text: string): { year: number; month: number } {
  const now = nowInTz();
  const ym = text.match(/(\d{4})[\/\-.](\d{1,2})/);
  if (ym) return { year: Number(ym[1]), month: Number(ym[2]) };
  const mCn: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
  };
  const m = text.match(/(\d{1,2})\s*月/);
  if (m) return { year: now.getFullYear(), month: Number(m[1]) };
  const cm = text.match(/(十一|十二|十|一|二|三|四|五|六|七|八|九)月/);
  if (cm) return { year: now.getFullYear(), month: mCn[cm[1]] };
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function pad(n: number): string {
  return ("0" + n).slice(-2);
}

async function viaTravelpayouts(origin: string, dest: string, year: number, month: number, token: string): Promise<Offer[]> {
  const ym = `${year}-${pad(month)}`;
  const url =
    `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${origin}&destination=${dest}` +
    `&currency=TWD&departure_at=${ym}&one_way=true&sorting=price&direct=false&limit=30&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { success?: boolean; data?: Array<{ price?: number; departure_at?: string; airline?: string; transfers?: number }> };
  const rows = data.data ?? [];
  return rows
    .filter((r) => typeof r.price === "number")
    .map((r) => ({
      price: r.price as number,
      currency: "TWD",
      date: (r.departure_at ?? "").slice(0, 10),
      airline: r.airline ?? "",
      transfers: r.transfers ?? 0,
    }));
}

async function viaKiwi(origin: string, dest: string, year: number, month: number, token: string): Promise<Offer[]> {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const fmt = (d: Date) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  const url =
    `https://api.tequila.kiwi.com/v2/search?fly_from=${origin}&fly_to=${dest}` +
    `&date_from=${fmt(from)}&date_to=${fmt(to)}&curr=TWD&limit=20&sort=price&one_for_city=0`;
  const res = await fetch(url, { headers: { apikey: token, "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ price?: number; dTime?: number; airlines?: string[]; route?: Array<unknown> }> };
  return (data.data ?? [])
    .filter((r) => typeof r.price === "number")
    .map((r) => ({
      price: r.price as number,
      currency: "TWD",
      date: r.dTime ? new Date(r.dTime * 1000).toISOString().slice(0, 10) : "",
      airline: (r.airlines ?? [])[0] ?? "",
      transfers: Math.max(0, (r.route?.length ?? 1) - 1),
    }));
}

const flightSkill: SkillDefinition = {
  id: "flight",
  name: "低價機票",
  description: {
    zh: "查詢兩地間當月最低票價（需免費 API token：Travelpayouts 或 Kiwi）。",
    en: "Find the cheapest fares for a route in a given month (needs a free Travelpayouts or Kiwi API token).",
    ja: "指定月の最安値の航空券を検索（無料の Travelpayouts / Kiwi API トークンが必要）。",
  },
  usage: {
    zh: "機票 TPE NRT 或 機票 台北 東京 12月",
    en: "flight TPE NRT or flight Taipei Tokyo",
    ja: "機票 TPE NRT または 機票 台北 東京 12月",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "機票",
  triggerAliases: ["廉航", "票價", "flight", "機票比價", "便宜機票"],
  fields: [
    {
      key: "provider",
      label: { zh: "資料來源", en: "Provider", ja: "プロバイダー" },
      type: "select",
      options: [
        { value: "travelpayouts", label: "Travelpayouts（免費 token）" },
        { value: "kiwi", label: "Kiwi Tequila" },
      ],
    },
    { key: "token", label: { zh: "API Token", en: "API token", ja: "API トークン" }, secret: true, hint: { zh: "至 travelpayouts.com 或 tequila.kiwi.com 免費申請", en: "Free sign-up at travelpayouts.com or tequila.kiwi.com", ja: "travelpayouts.com または tequila.kiwi.com で無料取得" } },
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: { zh: "預設 6 小時；票價變動快可填 1h", en: "Default 6h; use 1h for fresher prices", ja: "既定 6 時間；1h でより新鮮に" } },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch("https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=TPE&destination=NRT&currency=TWD&limit=1", { headers: { "User-Agent": UA } });
      return [{ name: "Travelpayouts", ok: res.status < 500, detail: `HTTP ${res.status}（401=需 token）` }];
    } catch {
      return [{ name: "Travelpayouts", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const token = (ctx.config.token || "").trim();
    const provider = (ctx.config.provider || "travelpayouts").trim();
    if (!token) {
      await ctx.reply("機票技能尚未設定 API Token，請到設定頁填寫（Travelpayouts 或 Kiwi 皆可免費申請）。");
      return;
    }

    const airports = resolveAirports(ctx.args.toUpperCase());
    if (airports.length < 2) {
      await ctx.reply("請提供出發地與目的地，例如：阿寶請幫忙 機票 TPE NRT 或 機票 台北 東京 12月");
      return;
    }
    const [origin, dest] = airports;
    const { year, month } = parseMonth(ctx.args);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 360);
    const cacheKey = `flight-${provider}-${origin}-${dest}-${year}-${pad(month)}`;

    let offers = readCache<Offer[]>(cacheKey, ttlMs);
    if (!offers) {
      try {
        offers = provider === "kiwi" ? await viaKiwi(origin, dest, year, month, token) : await viaTravelpayouts(origin, dest, year, month, token);
      } catch (error) {
        logger.warn("機票查詢失敗", { provider, origin, dest, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("機票資料來源查詢失敗，請確認 token 是否正確。");
        return;
      }
      writeCache(cacheKey, offers);
    }

    const cheapest = offers.slice().sort((a, b) => a.price - b.price).slice(0, 5);
    if (cheapest.length === 0) {
      await ctx.reply(`${origin} → ${dest}（${year}/${pad(month)}）查無票價資料，換個月份或航點試試。`);
      return;
    }
    const lines = cheapest.map((o) => {
      const date = o.date ? o.date.slice(5).replace("-", "/") : "";
      const stop = o.transfers === 0 ? "直飛" : `轉${o.transfers}次`;
      return `${date} TWD ${o.price.toLocaleString("en-US")} ${stop}${o.airline ? ` ${o.airline}` : ""}`;
    });
    logger.info("機票查詢", { provider, origin, dest, count: cheapest.length });
    await ctx.reply(`${origin} → ${dest}（${year}/${pad(month)}）最低票價：\n${lines.join("\n")}`);
  },
};

export default flightSkill;
