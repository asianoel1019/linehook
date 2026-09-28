import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const RID = "a6e90031-7ec4-4089-afb5-361a4efe7202";
const API = `https://data.taipei/api/v1/dataset/${RID}?scope=resourceAquire`;
const CACHE_NAME = "taipei-garbage";
const MOENV_LINK = "https://hwms.moenv.gov.tw/dispPageBox/route/routeCP.aspx?ddsPageID=ROUTE";

interface GarbageRow {
  "行政區"?: string;
  "里別"?: string;
  "分隊"?: string;
  "車號"?: string;
  "路線"?: string;
  "車次"?: string;
  "抵達時間"?: string;
  "離開時間"?: string;
  "地點"?: string;
}

interface TaipeiResponse {
  result?: { count?: number; results?: GarbageRow[] };
}

const OTHER_CITY = ["高雄", "臺中", "台中", "臺南", "台南", "桃園", "基隆", "新竹", "苗栗", "彰化", "南投", "雲林", "嘉義", "屏東", "宜蘭", "花蓮", "臺東", "台東", "澎湖", "金門", "連江", "馬祖"];

async function fetchAll(): Promise<GarbageRow[]> {
  const all: GarbageRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${API}&limit=1000&offset=${offset}`, { headers: { "User-Agent": "LineHook/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as TaipeiResponse;
    const rows = data.result?.results ?? [];
    all.push(...rows);
    const count = data.result?.count ?? all.length;
    if (rows.length < 1000 || all.length >= count) break;
  }
  return all;
}

function hhmm(t: string | undefined): string {
  const s = (t ?? "").replace(/[^0-9]/g, "").padStart(4, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

const garbageSkill: SkillDefinition = {
  id: "garbage",
  name: "垃圾車時刻",
  description: {
    zh: "查詢垃圾車清運時間與停靠點（臺北市）。",
    en: "Garbage truck collection times and stops (Taipei City).",
    ja: "ごみ収集車の時間と停車地点（台北市）。",
  },
  usage: {
    zh: "垃圾車 士林區",
    en: "garbage Shilin",
    ja: "垃圾車 士林区",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "垃圾車",
  triggerAliases: ["垃圾", "清運", "收垃圾", "垃圾時間"],
  fields: [
    { key: "cacheTtl", label: { zh: "資料快取時間（TTL）", en: "Data cache TTL", ja: "データキャッシュ TTL" }, hint: "預設 1 天；可填 12h、1440" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${API}&limit=1`, { headers: { "User-Agent": "LineHook/1.0" } });
      return [{ name: "臺北市開放資料", ok: res.ok, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "臺北市開放資料", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 1440);
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|查一下|垃圾車|垃圾|清運|收垃圾|時間|時刻|路線|的|幾點/g, " ")
      .replace(/臺北|台北/g, " ")
      .trim();

    const cityHit = OTHER_CITY.find((c) => ctx.args.includes(c));
    if (cityHit) {
      await ctx.reply(`目前垃圾車技能支援臺北市；其他縣市請至全國清運查詢網：\n${MOENV_LINK}`);
      return;
    }
    if (!keyword) {
      await ctx.reply("請提供行政區、里名或路段，例如：阿寶請幫忙 垃圾車 士林區 / 垃圾車 天母西路");
      return;
    }

    let rows = readCache<GarbageRow[]>(CACHE_NAME, ttlMs);
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      try {
        rows = await fetchAll();
      } catch (error) {
        logger.warn("垃圾車資料取得失敗", { error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("臺北市開放資料目前無法使用，請稍後再試。");
        return;
      }
      writeCache(CACHE_NAME, rows);
    }

    const kw = keyword;
    const matched = rows.filter((r) =>
      [r["行政區"], r["里別"], r["地點"], r["路線"], r["分隊"]].some((v) => (v ?? "").includes(kw)),
    );
    if (matched.length === 0) {
      await ctx.reply(`查不到「${kw}」的垃圾車清運點，請換個行政區、里名或路段試試。`);
      return;
    }

    const now = nowInTz();
    const nowHHMM = `${("0" + now.getHours()).slice(-2)}${("0" + now.getMinutes()).slice(-2)}`;
    const sorted = matched
      .slice()
      .sort((a, b) => (a["抵達時間"] ?? "").localeCompare(b["抵達時間"] ?? ""));
    const upcoming = sorted.filter((r) => (r["抵達時間"] ?? "") >= nowHHMM);
    const list = (upcoming.length > 0 ? upcoming : sorted).slice(0, 6);

    const lines = list.map((r) => {
      const time = `${hhmm(r["抵達時間"])}${r["離開時間"] ? `-${hhmm(r["離開時間"])}` : ""}`;
      return `${time}  ${r["地點"] ?? ""}${r["路線"] ? `（${r["路線"]} ${r["車號"] ?? ""}）` : ""}`;
    });
    const note = upcoming.length > 0 ? "" : "\n（今日已無後續班次，以下為全部時段）";
    logger.info("垃圾車查詢", { keyword: kw, matched: matched.length });
    await ctx.reply(`臺北市垃圾車（${kw}）共 ${matched.length} 個清運點，接下來：\n${lines.join("\n")}${note}\n※ 週三、週日停收`);
  },
};

export default garbageSkill;
