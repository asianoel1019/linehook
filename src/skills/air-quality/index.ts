import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const CACHE_NAME = "air-quality";
const USER_AGENT = "Mozilla/5.0 (compatible; LineHook/1.0)";

export interface AqiReading {
  station: string;
  aqi: number;
  pollutant: string;
  status: string;
  time: string;
}

interface Source {
  name: string;
  build: (city: string, token: string) => string;
}

// 多來源備援：waqi 為主，其餘為鏡像/替代
const SOURCES: Source[] = [
  {
    name: "WAQI",
    build: (city, token) =>
      `https://api.waqi.info/feed/${encodeURIComponent(city)}/?token=${token || "demo"}`,
  },
  {
    name: "WAQI (search)",
    build: (city, token) =>
      `https://api.waqi.info/search/?keyword=${encodeURIComponent(city)}&token=${token || "demo"}`,
  },
];

const health: Record<string, { ok: boolean; detail: string }> = {};

async function fetchJson(url: string): Promise<unknown> {
  return netFetchJson<unknown>(
    url,
    { headers: { "User-Agent": USER_AGENT } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

function parseWaqi(data: unknown): AqiReading | null {
  const d = data as { status?: string; data?: Record<string, unknown> | Array<Record<string, unknown>> };
  if (d.status !== "ok") return null;
  if (Array.isArray(d.data)) {
    const first = d.data[0] as { aqi?: string; station?: { name?: string }; time?: { stime?: string } } | undefined;
    if (!first) return null;
    return {
      station: first.station?.name ?? "",
      aqi: Number(first.aqi),
      pollutant: "pm25",
      status: "",
      time: first.time?.stime ?? "",
    };
  }
  const dd = d.data as Record<string, unknown> | undefined;
  if (!dd) return null;
  const iaqi = (dd.iaqi as Record<string, { v?: number }> | undefined) ?? {};
  const pollutant = ["pm25", "pm10", "o3", "no2", "so2", "co"].find((p) => iaqi[p]);
  return {
    station: String((dd.city as { name?: string } | undefined)?.name ?? ""),
    aqi: Number(dd.aqi),
    pollutant: pollutant ?? "-",
    status: "",
    time: String((dd.time as { s?: string } | undefined)?.s ?? ""),
  };
}

export function aqiLevel(aqi: number): string {
  if (!Number.isFinite(aqi)) return "未知";
  if (aqi <= 50) return "良好";
  if (aqi <= 100) return "普通";
  if (aqi <= 150) return "對敏感族群不健康";
  if (aqi <= 200) return "對所有族群不健康";
  if (aqi <= 300) return "非常不健康";
  return "危害";
}

export async function getReading(city: string, token: string): Promise<{ reading: AqiReading; source: string }> {
  let lastError = "";
  for (const source of SOURCES) {
    try {
      const data = await fetchJson(source.build(city, token));
      const reading = parseWaqi(data);
      if (reading && Number.isFinite(reading.aqi)) {
        health[source.name] = { ok: true, detail: "OK" };
        return { reading, source: source.name };
      }
      lastError = "無資料";
      health[source.name] = { ok: false, detail: "無資料" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      health[source.name] = { ok: false, detail: lastError };
    }
  }
  throw new Error(lastError);
}

const airQualitySkill: SkillDefinition = {
  id: "air-quality",
  name: "空氣品質",
  description: {
    zh: "查詢空氣品質 AQI（預設台北）。",
    en: "Air quality AQI (default Taipei).",
    ja: "空気品質 AQI（既定は台北）。",
  },
  usage: {
    zh: "空品 高雄",
    en: "aqi Kaohsiung",
    ja: "空品 高雄",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "空品",
  triggerAliases: ["空氣品質", "aqi", "空汙", "空氣"],
  fields: [
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；可填 10m、30m" },
    { key: "waqiToken", label: "WAQI Token", hint: "選填；留空用 demo（易受速率限制），可至 aqicn.org 申請免費 token" },
  ],
  async health(): Promise<SkillHealth[]> {
    return SOURCES.map((s) => ({
      name: s.name,
      ok: health[s.name] ? health[s.name].ok : false,
      detail: health[s.name] ? health[s.name].detail : "尚未檢查",
    }));
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const token = (ctx.config.waqiToken || "").trim();
    const cityMatch = ctx.args.replace(/請幫忙|請幫|幫忙|查詢|空氣品質|空品|aqi|空汙|的/g, " ").trim();
    const city = cityMatch || "taipei";
    const cityKey = `aqi-${city}`;

    try {
      let cached = readCache<{ reading: AqiReading; source: string }>(cityKey, ttlMs);
      if (!cached) {
        cached = await getReading(city, token);
        writeCache(cityKey, cached);
      }
      const r = cached.reading;
      await ctx.reply(
        `${city} 空氣品質（${cached.source}）：AQI ${r.aqi}（${aqiLevel(r.aqi)}）\n主要污染物：${r.pollutant}${r.time ? `\n更新：${r.time}` : ""}`,
      );
      logger.info("空品查詢", { city, aqi: r.aqi });
    } catch (error) {
      logger.error("空品查詢失敗", { error: String(error) });
      await ctx.reply("空品資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default airQualitySkill;
