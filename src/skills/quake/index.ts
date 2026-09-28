import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const CACHE_NAME = "quake";

interface UsgsFeature {
  properties?: {
    mag?: number | null;
    place?: string | null;
    time?: number;
    url?: string;
    tsunami?: number;
  };
  geometry?: { coordinates?: [number, number, number] };
}

interface UsgsResp {
  features?: UsgsFeature[];
}

export interface Quake {
  mag: number;
  place: string;
  timeMs: number;
  depthKm: number;
  url: string;
  tsunami: boolean;
  source: string;
}

function fmtTaipei(ms: number): string {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

export function fromUsgs(data: UsgsResp): Quake[] {
  const out: Quake[] = [];
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    if (p.mag === undefined || p.mag === null || p.time === undefined) continue;
    out.push({
      mag: p.mag,
      place: p.place ?? "未知地點",
      timeMs: p.time,
      depthKm: f.geometry?.coordinates?.[2] ?? NaN,
      url: p.url ?? "",
      tsunami: p.tsunami === 1,
      source: "USGS",
    });
  }
  return out;
}

/** CWA E-A0015-001（需 key）：結構若變動則回空陣列，由呼叫端退回 USGS。 */
export function fromCwa(data: unknown): Quake[] {
  const out: Quake[] = [];
  const root = (data as { records?: { Earthquake?: unknown[] } })?.records?.Earthquake;
  if (!Array.isArray(root)) return out;
  for (const raw of root) {
    const e = raw as {
      EarthquakeNo?: unknown;
      OriginTime?: unknown;
      FocalDepth?: unknown;
      Epicenter?: { Location?: unknown };
      EarthquakeMagnitude?: { MagnitudeValue?: unknown };
      ReportUrl?: unknown;
    };
    const mag = Number(e?.EarthquakeMagnitude?.MagnitudeValue);
    const t = Date.parse(String(e?.OriginTime ?? ""));
    if (!Number.isFinite(mag) || Number.isNaN(t)) continue;
    out.push({
      mag,
      place: String(e?.Epicenter?.Location ?? `編號 ${e?.EarthquakeNo ?? "?"}`),
      timeMs: t,
      depthKm: Number(e?.FocalDepth ?? NaN),
      url: typeof e?.ReportUrl === "string" ? e.ReportUrl : "",
      tsunami: false,
      source: "CWA",
    });
  }
  return out.sort((a, b) => b.timeMs - a.timeMs);
}

export function formatQuake(q: Quake): string {
  const depth = Number.isFinite(q.depthKm) ? `深${q.depthKm}km` : "";
  const tsunami = q.tsunami ? " ⚠️海嘯警報" : "";
  return `M${q.mag} ${q.place}\n${fmtTaipei(q.timeMs)} ${depth}${tsunami}（${q.source}）`;
}

const quakeSkill: SkillDefinition = {
  id: "quake",
  name: "地震速報",
  description: {
    zh: "查詢台灣附近最新地震（USGS 免 key；可填 CWA key 用氣象署資料）。",
    en: "Latest earthquakes near Taiwan (USGS, no key; optional CWA key).",
    ja: "台湾付近の最新地震（USGS、キー不要；CWA キー任意）。",
  },
  usage: {
    zh: "地震",
    en: "earthquake",
    ja: "地震",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "地震",
  triggerAliases: ["earthquake", "震度", "地震速報"],
  fields: [
    { key: "cwaKey", label: { zh: "CWA API Key", en: "CWA API Key", ja: "CWA API キー" }, secret: true, hint: "選填；至 opendata.cwa.gov.tw 免費註冊，留空用 USGS" },
    { key: "minMag", label: { zh: "最小規模", en: "Min magnitude", ja: "最小マグニチュード" }, hint: "預設 4；指令中的數字會覆蓋（例如：地震 5）" },
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 10 分鐘" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      await netFetchJson(`${USGS}?format=geojson&limit=1`, undefined, {
        timeoutMs: 15_000,
        maxBytes: 256 * 1024,
      });
      return [{ name: "USGS", ok: true, detail: "OK" }];
    } catch {
      return [{ name: "USGS", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const numMatch = ctx.args.match(/(\d+(?:\.\d+)?)/);
    const num = numMatch ? Number(numMatch[1]) : NaN;
    const minMag = Number.isFinite(num) && num >= 0 && num <= 9
      ? num
      : Number(ctx.config.minMag) || 4;
    const ttlMs = parseTtl(ctx.config.cacheTtl, 10);
    const cacheKey = `quake-${minMag}`;
    try {
      let quakes = readCache<Quake[]>(cacheKey, ttlMs);
      if (!quakes) {
        const key = (ctx.config.cwaKey || "").trim();
        if (key) {
          try {
            const cwa = await netFetchJson<unknown>(
              `https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001?Authorization=${encodeURIComponent(key)}&format=JSON`,
              undefined,
              { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
            );
            quakes = fromCwa(cwa).filter((q) => q.mag >= minMag).slice(0, 5);
          } catch (error) {
            logger.warn("CWA 地震失敗，改用 USGS", { error: String(error) });
          }
        }
        if (!quakes || quakes.length === 0) {
          const data = await netFetchJson<UsgsResp>(
            `${USGS}?format=geojson&minlatitude=21.5&maxlatitude=25.5&minlongitude=119&maxlongitude=123&minmagnitude=${minMag}&limit=5&orderby=time`,
            undefined,
            { timeoutMs: 15_000, maxBytes: 512 * 1024 },
          );
          quakes = fromUsgs(data);
        }
        writeCache(cacheKey, quakes);
      }
      if (quakes.length === 0) {
        await ctx.reply(`近期台灣附近無 M${minMag} 以上地震。`);
        return;
      }
      logger.info("地震查詢", { minMag, count: quakes.length });
      await ctx.reply(`台灣附近地震（M${minMag}+）：\n${quakes.map(formatQuake).join("\n")}`);
    } catch (error) {
      logger.error("地震查詢失敗", { error: String(error) });
      await ctx.reply("地震資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default quakeSkill;
