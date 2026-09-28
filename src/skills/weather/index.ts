import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const CACHE_NAME = "weather";
const UA = "Mozilla/5.0 (compatible; LineHook/1.0)";

interface Reading {
  city: string;
  tempC: number;
  feelsC?: number;
  humidity?: number;
  desc: string;
  source: string;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** 主來源：CWA F-C0032-001（需 key）。 */
async function fromCwa(city: string, key: string): Promise<Reading> {
  const url =
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${encodeURIComponent(key)}` +
    `&format=JSON&locationName=${encodeURIComponent(city)}`;
  const data = (await fetchJson(url)) as {
    records?: { location?: Array<{ locationName?: string; weatherElement?: Array<{ elementName?: string; time?: Array<{ parameter?: { parameterName?: string } }> }> }> };
  };
  const loc = data.records?.location?.[0];
  if (!loc) throw new Error("查無此城市");
  const el = (name: string) => loc.weatherElement?.find((e) => e.elementName === name)?.time?.[0]?.parameter?.parameterName ?? "";
  const desc = el("Wx");
  const pops = el("PoP");
  const minT = el("MinT");
  const maxT = el("MaxT");
  return {
    city: loc.locationName ?? city,
    tempC: Number(maxT) || Number(minT) || NaN,
    desc: `${desc}${pops ? `，降雨機率 ${pops}%` : ""}${minT && maxT ? `，${minT}~${maxT}°C` : ""}`,
    source: "CWA",
  };
}

/** 備援：wttr.in（免 key）。 */
async function fromWttr(city: string): Promise<Reading> {
  const data = (await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`)) as {
    current_condition?: Array<{ temp_C?: string; FeelsLikeC?: string; humidity?: string; weatherDesc?: Array<{ value?: string }> }>;
  };
  const c = data.current_condition?.[0];
  if (!c) throw new Error("查無資料");
  return {
    city,
    tempC: Number(c.temp_C),
    feelsC: Number(c.FeelsLikeC),
    humidity: Number(c.humidity),
    desc: c.weatherDesc?.[0]?.value ?? "",
    source: "wttr.in",
  };
}

const CITIES: Record<string, { lat: number; lon: number }> = {
  臺北: { lat: 25.03, lon: 121.56 }, 台北: { lat: 25.03, lon: 121.56 },
  新北: { lat: 25.01, lon: 121.46 }, 桃園: { lat: 24.99, lon: 121.3 },
  臺中: { lat: 24.15, lon: 120.68 }, 台中: { lat: 24.15, lon: 120.68 },
  臺南: { lat: 22.99, lon: 120.2 }, 台南: { lat: 22.99, lon: 120.2 },
  高雄: { lat: 22.63, lon: 120.3 }, 基隆: { lat: 25.13, lon: 121.74 },
  新竹: { lat: 24.8, lon: 120.97 }, 嘉義: { lat: 23.48, lon: 120.45 },
  花蓮: { lat: 23.98, lon: 121.6 }, 臺東: { lat: 22.76, lon: 121.14 },
  宜蘭: { lat: 24.75, lon: 121.75 }, 屏東: { lat: 22.67, lon: 120.49 },
};

/** 備援：open-meteo（免 key，需經緯度）。 */
async function fromOpenMeteo(city: string): Promise<Reading> {
  const coord = CITIES[city.trim().replace(/市$/, "")] ?? CITIES["臺北"];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FTaipei`;
  const data = (await fetchJson(url)) as { current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number } };
  const c = data.current;
  if (!c) throw new Error("查無資料");
  return {
    city,
    tempC: Number(c.temperature_2m),
    humidity: Number(c.relative_humidity_2m),
    desc: weatherCodeText(Number(c.weather_code)),
    source: "open-meteo",
  };
}

function weatherCodeText(code: number): string {
  if (code === 0) return "晴";
  if (code <= 3) return "多雲";
  if (code <= 48) return "有霧";
  if (code <= 67) return "雨";
  if (code <= 77) return "雪";
  if (code <= 82) return "陣雨";
  if (code <= 99) return "雷雨";
  return "";
}

const weatherSkill: SkillDefinition = {
  id: "weather",
  name: "天氣",
  description: {
    zh: "查詢天氣（CWA 或免 key 備援）。",
    en: "Check the weather (CWA or keyless fallback).",
    ja: "天気を調べます（CWA またはキー不要の代替）。",
  },
  usage: {
    zh: "天氣 台北",
    en: "weather Taipei",
    ja: "天氣 台北",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "天氣",
  triggerAliases: ["氣象", "weather", "氣溫"],
  fields: [
    { key: "cwaKey", label: { zh: "CWA API Key", en: "CWA API Key", ja: "CWA API キー" }, secret: true, hint: { zh: "選填；至 opendata.cwa.gov.tw 免費註冊", en: "Optional; free sign-up at opendata.cwa.gov.tw", ja: "任意；opendata.cwa.gov.tw で無料登録" } },
    { key: "cacheTtl", label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；可填 30m" },
  ],
  async health(): Promise<SkillHealth[]> {
    const list: SkillHealth[] = [];
    try {
      await fromWttr("Taipei");
      list.push({ name: "wttr.in", ok: true, detail: "OK" });
    } catch {
      list.push({ name: "wttr.in", ok: false, detail: "連線失敗" });
    }
    return list;
  },
  async run(ctx: SkillContext): Promise<void> {
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const city = ctx.args.replace(/請幫忙|請幫|幫忙|查|查詢|天氣|氣象|的/g, " ").trim() || "臺北";
    const key = (ctx.config.cwaKey || "").trim();
    const cacheKey = `weather-${city}`;

    let reading = readCache<Reading>(cacheKey, ttlMs);
    if (!reading) {
      const sources: Array<() => Promise<Reading>> = [];
      if (key) sources.push(() => fromCwa(city, key));
      sources.push(() => fromWttr(city), () => fromOpenMeteo(city));
      let err = "";
      for (const fn of sources) {
        try {
          reading = await fn();
          break;
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
      }
      if (!reading) {
        logger.error("天氣查詢失敗", { city, err });
        await ctx.reply("天氣資料來源目前無法使用，請稍後再試。");
        return;
      }
      writeCache(cacheKey, reading);
    }

    const feels = reading.feelsC !== undefined && Number.isFinite(reading.feelsC) ? `（體感 ${reading.feelsC}°C）` : "";
    const humid = reading.humidity !== undefined && Number.isFinite(reading.humidity) ? `\n濕度：${reading.humidity}%` : "";
    await ctx.reply(`${reading.city} 天氣（${reading.source}）：${reading.tempC}°C${feels} ${reading.desc}${humid}`);
  },
};

export default weatherSkill;
