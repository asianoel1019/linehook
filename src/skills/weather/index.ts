import { logger } from "@lw/logger";
import { config } from "@lw/config";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchBuffer, fetchJson as netFetchJson } from "@lw/net";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";
/** 雷達回波圖：CWA 對非瀏覽器 UA 回 403，必須帶完整 UA＋Referer 才抓得到。 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const RADAR_URL = "https://www.cwa.gov.tw/Data/radar/CV1_TW_3600.png";
/** 雷達圖本機快取時效（圖本身約 10 分鐘更新，抓太頻繁沒意義）。 */
const RADAR_TTL_MS = 10 * 60 * 1000;

export interface Reading {
  city: string;
  tempC: number;
  feelsC?: number;
  humidity?: number;
  desc: string;
  source: string;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return netFetchJson<unknown>(
    url,
    { headers: { "User-Agent": UA, ...headers } },
    { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 },
  );
}

/** 主來源：CWA F-C0032-001（需 key）。 */
async function fromCwa(city: string, key: string): Promise<Reading> {
  const url =
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${encodeURIComponent(key)}` +
    `&format=JSON&locationName=${encodeURIComponent(city)}`;
  const data = (await fetchJson(url)) as {
    records?: {
      location?: Array<{
        locationName?: string;
        weatherElement?: Array<{ elementName?: string; time?: Array<{ parameter?: { parameterName?: string } }> }>;
      }>;
    };
  };
  const loc = data.records?.location?.[0];
  if (!loc) throw new Error("查無此城市");
  const el = (name: string) =>
    loc.weatherElement?.find((e) => e.elementName === name)?.time?.[0]?.parameter?.parameterName ?? "";
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
    current_condition?: Array<{
      temp_C?: string;
      FeelsLikeC?: string;
      humidity?: string;
      weatherDesc?: Array<{ value?: string }>;
    }>;
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
  臺北: { lat: 25.03, lon: 121.56 },
  台北: { lat: 25.03, lon: 121.56 },
  新北: { lat: 25.01, lon: 121.46 },
  桃園: { lat: 24.99, lon: 121.3 },
  臺中: { lat: 24.15, lon: 120.68 },
  台中: { lat: 24.15, lon: 120.68 },
  臺南: { lat: 22.99, lon: 120.2 },
  台南: { lat: 22.99, lon: 120.2 },
  高雄: { lat: 22.63, lon: 120.3 },
  基隆: { lat: 25.13, lon: 121.74 },
  新竹: { lat: 24.8, lon: 120.97 },
  嘉義: { lat: 23.48, lon: 120.45 },
  花蓮: { lat: 23.98, lon: 121.6 },
  臺東: { lat: 22.76, lon: 121.14 },
  宜蘭: { lat: 24.75, lon: 121.75 },
  屏東: { lat: 22.67, lon: 120.49 },
};

/** 備援：open-meteo（免 key，需經緯度）。呼叫前已由 fetchWeather 驗證城市。 */
async function fromOpenMeteo(city: string): Promise<Reading> {
  const normalized = city.trim().replace(/市$/, "");
  const coord = CITIES[normalized];
  if (!coord) throw new Error(`查無「${city}」的天氣，目前僅支援台灣：${supportedCities().join("、")}`);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FTaipei`;
  const data = (await fetchJson(url)) as {
    current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number };
  };
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
  if (code <= 2) return "晴時多雲";
  if (code === 3) return "多雲";
  if (code <= 48) return "有霧";
  if (code <= 57) return "毛毛雨";
  if (code <= 67) return "雨";
  if (code <= 77) return "雪";
  if (code <= 82) return "陣雨";
  if (code <= 86) return "陣雪";
  if (code <= 99) return "雷雨";
  return "";
}

/** 支援的城市清單（H4：查無時明確報錯並列出，絕不靜默回傳替代城市）。 */
export function supportedCities(): string[] {
  return Object.keys(CITIES);
}

/* ── 雷達回波圖 ── */

async function fetchRadarImage(): Promise<string> {
  const dir = join(config.cachePath, "weather");
  const file = join(dir, "radar.png");
  try {
    mkdirSync(dir, { recursive: true });
    // 10 分鐘內的快取直接重用，避免每次查詢都打 CWA
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < RADAR_TTL_MS) return file;
    const buf = await fetchBuffer(
      RADAR_URL,
      { headers: { "User-Agent": BROWSER_UA, Referer: "https://www.cwa.gov.tw/" } },
      { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 },
    );
    if (buf.length < 1024) throw new Error("回應過小，可能不是圖片");
    writeFileSync(file, buf);
    return file;
  } catch (error) {
    logger.warn("雷達回波圖下載失敗", { error: error instanceof Error ? error.message : String(error) });
    if (existsSync(file)) return file; // 寧可用舊圖，也不要完全沒圖
    throw new Error("雷達回波圖暫時無法取得");
  }
}

/* ── 一週預報（open-meteo daily，免 key；與天氣技能同一套經緯度表） ── */

export interface DayForecast {
  date: string;
  maxC: number;
  minC: number;
  pop: number;
  desc: string;
}

interface WeeklyResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    weathercode?: number[];
  };
}

/** 解析 open-meteo daily 回應 → 每日預報（長度以 time 為準，缺值填 NaN/空）。 */
export function parseWeekly(data: unknown, limit = 7): DayForecast[] {
  const daily = (data as WeeklyResponse | null)?.daily;
  const times = Array.isArray(daily?.time) ? daily!.time! : [];
  const out: DayForecast[] = [];
  for (let i = 0; i < Math.min(times.length, limit); i++) {
    out.push({
      date: times[i],
      maxC: Number(daily?.temperature_2m_max?.[i] ?? NaN),
      minC: Number(daily?.temperature_2m_min?.[i] ?? NaN),
      pop: Number(daily?.precipitation_probability_max?.[i] ?? 0),
      desc: weatherCodeText(Number(daily?.weathercode?.[i] ?? -1)),
    });
  }
  return out;
}

function formatWeekly(city: string, days: DayForecast[]): string {
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const lines = days.map((d) => {
    const dt = new Date(`${d.date}T00:00:00Z`);
    const wd = WEEK[dt.getUTCDay()];
    const t =
      Number.isFinite(d.maxC) && Number.isFinite(d.minC) ? `${Math.round(d.maxC)}°/${Math.round(d.minC)}°` : "-";
    return `・${d.date.slice(5).replace("-", "/")}（${wd}）${t} ${d.desc}${d.pop > 0 ? `・雨 ${d.pop}%` : ""}`;
  });
  return `${city} 一週天氣（open-meteo）：\n${lines.join("\n")}`;
}

/** 抓取天氣（含 CWA→wttr.in→open-meteo 備援鏈與快取），供 run 與晨報共用。 */
export async function fetchWeather(city: string, cwaKey: string, ttlMs: number): Promise<Reading> {
  const normalized = city.trim().replace(/市$/, "");
  if (!CITIES[normalized]) {
    throw new Error(`查無「${city}」的天氣，目前僅支援台灣：${supportedCities().join("、")}`);
  }
  const cacheKey = `weather-${city}`;
  const hit = readCache<Reading>(cacheKey, ttlMs);
  if (hit) return hit;

  const sources: Array<() => Promise<Reading>> = [];
  const key = cwaKey.trim();
  if (key) sources.push(() => fromCwa(city, key));
  sources.push(
    () => fromWttr(city),
    () => fromOpenMeteo(city),
  );
  let err = "";
  for (const fn of sources) {
    try {
      const reading = await fn();
      writeCache(cacheKey, reading);
      return reading;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(err || "天氣資料來源皆失敗");
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
    zh: "天氣 台北；天氣 一週 高雄；天氣 雷達",
    en: "weather Taipei; weather weekly Kaohsiung; weather radar",
    ja: "天気 台北; 天気 一週 高雄; 天気 レーダー",
  },
  category: {
    zh: "生活資訊",
    en: "Life",
    ja: "生活",
  },
  defaultTrigger: "天氣",
  triggerAliases: ["氣象", "weather", "氣溫"],
  fields: [
    {
      key: "cwaKey",
      label: { zh: "CWA API Key", en: "CWA API Key", ja: "CWA API キー" },
      secret: true,
      hint: {
        zh: "選填；至 opendata.cwa.gov.tw 免費註冊",
        en: "Optional; free sign-up at opendata.cwa.gov.tw",
        ja: "任意；opendata.cwa.gov.tw で無料登録",
      },
    },
    {
      key: "cacheTtl",
      label: { zh: "快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" },
      hint: "預設 60 分鐘；可填 30m",
    },
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
    const rawArgs = ctx.args.replace(/請幫忙|請幫|幫忙|查|查詢|天氣|氣象|的/g, " ").trim();

    // 雷達回波圖
    if (/雷達|回波|rain.?radar/i.test(rawArgs)) {
      try {
        const file = await fetchRadarImage();
        await ctx.reply("🌧 雷達回波圖（中央氣象署，約 10 分鐘更新）");
        await ctx.sendImage(file, "radar.png");
      } catch (error) {
        logger.warn("雷達回波圖送出失敗", { error: error instanceof Error ? error.message : String(error) });
        await ctx.reply("雷達回波圖暫時無法取得，請稍後再試。");
      }
      return;
    }

    // 一週預報
    if (/一週|一周|每週|七天|7天|weekly/i.test(rawArgs)) {
      const city = rawArgs.replace(/一週|一周|每週|七天|7天|weekly/g, " ").trim() || "臺北";
      const coord = CITIES[city] ?? CITIES[city.replace(/市$/, "")];
      if (!coord) {
        await ctx.reply(`查無「${city}」的天氣，目前僅支援台灣：${supportedCities().join("、")}`);
        return;
      }
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=Asia%2FTaipei&forecast_days=7`;
        const data = await netFetchJson<unknown>(
          url,
          { headers: { "User-Agent": UA } },
          { timeoutMs: 15_000, maxBytes: 1024 * 1024 },
        );
        const days = parseWeekly(data, 7);
        if (days.length === 0) throw new Error("解析不到每日資料");
        await ctx.reply(formatWeekly(city, days));
      } catch (error) {
        logger.error("一週預報失敗", { city, err: error instanceof Error ? error.message : String(error) });
        await ctx.reply("一週天氣暫時無法取得，請稍後再試。");
      }
      return;
    }

    const city = rawArgs || "臺北";
    const key = (ctx.config.cwaKey || "").trim();
    let reading: Reading;
    try {
      reading = await fetchWeather(city, key, ttlMs);
    } catch (error) {
      logger.error("天氣查詢失敗", { city, err: error instanceof Error ? error.message : String(error) });
      await ctx.reply("天氣資料來源目前無法使用，請稍後再試。");
      return;
    }

    const feels = reading.feelsC !== undefined && Number.isFinite(reading.feelsC) ? `（體感 ${reading.feelsC}°C）` : "";
    const humid =
      reading.humidity !== undefined && Number.isFinite(reading.humidity) ? `\n濕度：${reading.humidity}%` : "";
    await ctx.reply(`${reading.city} 天氣（${reading.source}）：${reading.tempC}°C${feels} ${reading.desc}${humid}`);
  },
};

export default weatherSkill;
