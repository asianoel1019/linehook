import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchJson as netFetchJson } from "@lw/net";
import { haversineMeters, formatDistance } from "@lw/skills/geo";
import type { SkillContext, SkillDefinition, SkillHealth } from "@lw/skills/types";

// 轉匯出共用 geo（保持既有 import 路徑可用）。
export { haversineMeters, formatDistance };

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bike";
// 附近查詢是進階服務，走 /api/advanced/v2（basic 下沒有這兩條，照打只會 404）
// 出處：TDX 官方論壇「如何搜尋附近的ubike站點」
const TDX_NEARBY_BASE = "https://tdx.transportdata.tw/api/advanced/v2/Bike";

interface BikeStation {
  StationUID: string;
  StationID: string;
  StationName?: { Zh_tw?: string; En?: string };
  StationAddress?: { Zh_tw?: string };
  StationPosition?: { PositionLat?: number; PositionLon?: number };
  BikesCapacity?: number;
}

interface BikeAvailability {
  StationUID: string;
  StationID: string;
  ServiceStatus?: number;
  AvailableRentBikes?: number;
  AvailableReturnBikes?: number;
  SrcUpdateTime?: string;
  UpdateTime?: string;
}

const CITIES: Record<string, string> = {
  台北: "Taipei",
  臺北: "Taipei",
  新北: "NewTaipei",
  新北市: "NewTaipei",
  桃園: "Taoyuan",
  新竹: "Hsinchu",
  苗栗: "MiaoliCounty",
  台中: "Taichung",
  臺中: "Taichung",
  嘉義: "Chiayi",
  台南: "Tainan",
  臺南: "Tainan",
  高雄: "Kaohsiung",
  屏東: "PingtungCounty",
  宜蘭: "YilanCounty",
  花蓮: "HualienCounty",
  台東: "TaitungCounty",
  臺東: "TaitungCounty",
};

let tokenCache: { token: string; expires: number } | null = null;

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 30_000) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  // P0-3：走 @lw/net（出站統計＋超時），訊息保持原樣。
  let data: { access_token: string; expires_in: number };
  try {
    data = await netFetchJson<{ access_token: string; expires_in: number }>(TDX_AUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`TDX 認證失敗（${error instanceof Error ? error.message : String(error)}）`);
  }
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function tdxGet<T>(url: string, token: string): Promise<T> {
  return netFetchJson<T>(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 },
  );
}

export interface StationStatus {
  name: string;
  address: string;
  rent: number;
  ret: number;
  capacity: number;
  paused: boolean;
  updated: string;
}

export function mergeAvailability(stations: BikeStation[], avail: BikeAvailability[]): StationStatus[] {
  const map = new Map(avail.map((a) => [a.StationUID || a.StationID, a]));
  return stations.map((s) => {
    const a = map.get(s.StationUID) ?? map.get(s.StationID);
    return {
      name: s.StationName?.Zh_tw ?? s.StationID,
      address: s.StationAddress?.Zh_tw ?? "",
      rent: a?.AvailableRentBikes ?? -1,
      ret: a?.AvailableReturnBikes ?? -1,
      capacity: s.BikesCapacity ?? 0,
      paused: a?.ServiceStatus !== undefined && a.ServiceStatus !== 1,
      updated: (a?.SrcUpdateTime ?? a?.UpdateTime ?? "").replace("T", " ").slice(0, 16),
    };
  });
}

export function matchCity(args: string, fallback: string): string {
  for (const [name, code] of Object.entries(CITIES)) {
    if (args.includes(name)) return code;
  }
  return fallback;
}

/** 正規化比對字串（臺→台；全半形空白收斂）。 */
export function normName(s: string): string {
  return s.replace(/臺/g, "台").replace(/\s+/g, "");
}

/** 站名模糊候選：原字＋去站尾（「市政府站」→ 兼試「市政府」）。 */
export function keywordCandidates(keyword: string): string[] {
  const base = normName(keyword);
  if (!base) return [];
  const out = [base];
  const noStation = base.replace(/站$/, "");
  if (noStation && noStation !== base) out.push(noStation);
  return out;
}

export type BikeIntent = "rent" | "ret" | null;

/** 借還意圖偵測（借/租/騎 → 借車；還/停 → 還車）。 */
export function detectIntent(text: string): BikeIntent {
  if (/還車|還\b|要還|停車|空位|可還/.test(text)) return "ret";
  if (/借車|借\b|要借|租車|租|騎車|騎|可借/.test(text)) return "rent";
  return null;
}

/** 依意圖排序（借→可借多在前；還→可還多在前；暫停服務沉底）。 */
export function sortByIntent(rows: StationStatus[], intent: BikeIntent): StationStatus[] {
  if (!intent) return rows;
  const key = intent === "rent" ? "rent" : "ret";
  return [...rows].sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    return (b[key] < 0 ? -1 : b[key]) - (a[key] < 0 ? -1 : a[key]);
  });
}

/** 附近站點（含距使用者公尺數）。 */
export interface NearbyStatus extends StationStatus {
  distanceM: number;
}

/** TDX 附近站上限半徑（公尺；超過會被 TDX 拒絕）。 */
export const NEARBY_RADIUS_MAX = 1000;

/** 從錯誤訊息挖 HTTP 狀態碼（net 層格式為 `HTTP <code>`）。 */
export function httpStatusOf(error: unknown): number | null {
  const m = /HTTP (\d{3})/.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : null;
}

/** 站點地址開頭縣市 → TDX 城市代碼（Availability 備援用；多數決）。 */
const ADDRESS_CITY: Array<[string, string]> = [
  ["台北市", "Taipei"],
  ["臺北市", "Taipei"],
  ["新北市", "NewTaipei"],
  ["桃園市", "Taoyuan"],
  ["新竹市", "Hsinchu"],
  ["新竹縣", "HsinchuCounty"],
  ["苗栗縣", "MiaoliCounty"],
  ["台中市", "Taichung"],
  ["臺中市", "Taichung"],
  ["嘉義市", "Chiayi"],
  ["嘉義縣", "ChiayiCounty"],
  ["台南市", "Tainan"],
  ["臺南市", "Tainan"],
  ["高雄市", "Kaohsiung"],
  ["屏東縣", "PingtungCounty"],
  ["宜蘭縣", "YilanCounty"],
  ["花蓮縣", "HualienCounty"],
  ["台東縣", "TaitungCounty"],
  ["臺東縣", "TaitungCounty"],
];

export function cityFromAddresses(addresses: string[]): string | null {
  const votes = new Map<string, number>();
  for (const addr of addresses) {
    const a = (addr || "").trim();
    for (const [prefix, city] of ADDRESS_CITY) {
      if (a.startsWith(prefix)) {
        votes.set(city, (votes.get(city) ?? 0) + 1);
        break;
      }
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [city, n] of votes) {
    if (n > bestN) {
      best = city;
      bestN = n;
    }
  }
  return best;
}

/** 抓附近站點＋即時車位，回傳依距離排序（暫停服務沉底）。 */
export async function fetchNearby(
  lat: number,
  lon: number,
  radiusM: number,
  token: string,
  ttlMs: number,
): Promise<NearbyStatus[]> {
  const radius = Math.min(Math.max(Math.round(radiusM) || NEARBY_RADIUS_MAX, 100), NEARBY_RADIUS_MAX);
  const key = `ybike-nearby-${lat.toFixed(3)}-${lon.toFixed(3)}`;
  let stations = readCache<BikeStation[]>(key, ttlMs);
  if (!stations || stations.length === 0) {
    // 過濾式照官方範例：半形空格＋整段編碼（nearby(22.999494, 120.218642, 300)）
    const filter = encodeURIComponent(`nearby(${lat}, ${lon}, ${radius})`);
    stations = await tdxGet<BikeStation[]>(
      `${TDX_NEARBY_BASE}/Station/NearBy?$spatialFilter=${filter}&$top=30&$format=JSON`,
      token,
    );
    if (stations.length > 0) writeCache(key, stations);
  }
  const filter = encodeURIComponent(`nearby(${lat}, ${lon}, ${radius})`);
  let avail: BikeAvailability[];
  try {
    avail = await tdxGet<BikeAvailability[]>(
      `${TDX_NEARBY_BASE}/Availability/NearBy?$spatialFilter=${filter}&$top=30&$format=JSON`,
      token,
    );
  } catch (error) {
    if (httpStatusOf(error) !== 404) throw error;
    // 極少數狀況 Availability/NearBy 不通：從站點地址多數決縣市，改抓整縣市再過濾
    const city = cityFromAddresses(stations.map((s) => s.StationAddress?.Zh_tw ?? ""));
    logger.warn("Availability/NearBy 失敗，改抓縣市", { city });
    if (!city) throw error;
    const all = await tdxGet<BikeAvailability[]>(`${TDX_BASE}/Availability/City/${city}?$format=JSON`, token);
    const wanted = new Set(stations.map((s) => s.StationUID || s.StationID));
    avail = all.filter((a) => wanted.has(a.StationUID || a.StationID));
  }
  const rows = mergeAvailability(stations, avail).map((s, i) => {
    const pos = stations[i]?.StationPosition;
    const distanceM =
      typeof pos?.PositionLat === "number" && typeof pos?.PositionLon === "number"
        ? Math.round(haversineMeters(lat, lon, pos.PositionLat, pos.PositionLon))
        : Number.POSITIVE_INFINITY;
    return { ...s, distanceM };
  });
  return rows.sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    return a.distanceM - b.distanceM;
  });
}

const ybikeSkill: SkillDefinition = {
  id: "ybike",
  name: "YouBike 即時車位",
  description: {
    zh: "查詢 YouBike 站點即時可借可還數量（需 TDX API key，可與火車技能共用）。",
    en: "Live YouBike station availability (requires TDX API key).",
    ja: "YouBike の空き状況を調べます（TDX API キーが必要）。",
  },
  usage: {
    zh: "YouBike 台北車站；YouBike 信義區；YouBike 市府路 要借；直接傳送位置查附近站點",
    en: "YouBike Taipei Main Station; or send a location for nearby stations",
    ja: "YouBike 台北駅",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "YouBike",
  naturalKeywords: ["有車可借嗎", "可借幾台", "附近有車嗎", "單車站", "YouBike", "ubike"],
  triggerAliases: ["ubike", "微笑單車", "單車"],
  handlesLocation: true,
  fields: [
    { key: "tdxClientId", label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" }, hint: "至 https://tdx.transportdata.tw 註冊取得，可與火車技能共用" },
    { key: "tdxClientSecret", label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" }, secret: true },
    { key: "city", label: { zh: "預設縣市", en: "Default city", ja: "既定の都市" }, hint: "例如 台北；指令中也可直接指定（YouBike 高雄 巨蛋）" },
    { key: "nearRadius", label: { zh: "附近搜尋半徑（公尺）", en: "Nearby radius (m)", ja: "近隣検索の半径（m）" }, hint: "傳送位置時找多遠的站；100–1000，預設 1000（TDX 上限）" },
    { key: "cacheTtl", label: { zh: "站點快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 60 分鐘；車位動態固定快取 2 分鐘" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${TDX_BASE}/Station/City/Taipei?$format=JSON&$top=1`, {
        signal: AbortSignal.timeout(15_000),
      });
      // 401 表示路徑正確、只缺 token；其他 2xx/4xx 亦視為服務存活
      return [{ name: "TDX Bike", ok: res.status < 500, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "TDX Bike", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const clientId = (ctx.config.tdxClientId || "").trim();
    const clientSecret = (ctx.config.tdxClientSecret || "").trim();
    if (!clientId || !clientSecret) {
      await ctx.reply("YouBike 技能尚未設定 TDX API key，請到技能設定填寫（可與火車技能共用同一組）。");
      return;
    }
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);

    // 位置訊息：直接查附近站點（免站名）
    if (ctx.location) {
      const { latitude, longitude } = ctx.location;
      const radius = Math.min(Math.max(Number(ctx.config.nearRadius) || NEARBY_RADIUS_MAX, 100), NEARBY_RADIUS_MAX);
      try {
        const token = await getToken(clientId, clientSecret);
        const rows = (await fetchNearby(latitude, longitude, radius, token, ttlMs)).slice(0, 8);
        if (rows.length === 0) {
          await ctx.reply(`附近 ${radius} 公尺內沒有 YouBike 站點，試著移動後再傳一次位置。`);
          return;
        }
        const lines = rows.map((s) => {
          const status = s.paused ? "（暫停服務）" : "";
          const rent = s.rent >= 0 ? `${s.rent}` : "?";
          const ret = s.ret >= 0 ? `${s.ret}` : "?";
          return `・${s.name}${status}（${formatDistance(s.distanceM)}）\n  可借 ${rent}／可還 ${ret}`;
        });
        logger.info("YouBike 附近查詢", { lat: latitude, lon: longitude, count: rows.length });
        await ctx.reply(`附近的 YouBike（${radius} 公尺內）：\n${lines.join("\n")}`);
      } catch (error) {
        logger.error("YouBike 附近查詢失敗", { error: String(error) });
        await ctx.reply("YouBike 資料來源目前無法使用，請稍後再試。");
      }
      return;
    }

    const city = matchCity(ctx.args, CITIES[(ctx.config.city || "台北").trim()] ?? "Taipei");
    // 關鍵字保留站名原形（不切「站」字）；城市名由 matchCity 另行處理
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|查一下|YouBike|ubike|微笑單車|單車|腳踏車|車位|附近|哪裡|哪邊|要借|要還|借車|還車|可借|可還|有車|有位|的/gi, " ")
      .trim();
    const candidates = keyword.split(/\s+/).flatMap((t) => keywordCandidates(t));
    if (candidates.length === 0 || /^[?？!！….\s]+$/.test(keyword)) {
      await ctx.reply(
        "請指定站名、路名或區域名，例如：\nYouBike 台北車站\nYouBike 信義區\nYouBike 市府路 要借（只找有車的）\nYouBike 要還（只找有位可還）",
      );
      return;
    }
    try {
      const token = await getToken(clientId, clientSecret);
      const stationKey = `ybike-stations-${city}`;
      let stations = readCache<BikeStation[]>(stationKey, ttlMs);
      if (!stations || stations.length === 0) {
        stations = await tdxGet<BikeStation[]>(`${TDX_BASE}/Station/City/${city}?$format=JSON`, token);
        writeCache(stationKey, stations);
      }
      const avail = await tdxGet<BikeAvailability[]>(
        `${TDX_BASE}/Availability/City/${city}?$format=JSON`,
        token,
      );
      const intent = detectIntent(ctx.args);
      const rows = sortByIntent(
        mergeAvailability(stations, avail).filter((s) => {
          const name = normName(s.name);
          const addr = normName(s.address);
          return candidates.some((c) => name.includes(c) || addr.includes(c));
        }),
        intent,
      ).slice(0, 8);
      if (rows.length === 0) {
        await ctx.reply(`在${city}查無「${keyword}」相關站點，請換個站名、路名或區域名試試。`);
        return;
      }
      const lines = rows.map((s) => {
        const status = s.paused ? "（暫停服務）" : "";
        const rent = s.rent >= 0 ? `${s.rent}` : "?";
        const ret = s.ret >= 0 ? `${s.ret}` : "?";
        return `・${s.name}${status}\n  可借 ${rent}／可還 ${ret}${s.updated ? `（${s.updated}）` : ""}`;
      });
      logger.info("YouBike 查詢", { city, keyword, count: rows.length });
      await ctx.reply(`YouBike 即時車位：\n${lines.join("\n")}`);
    } catch (error) {
      logger.error("YouBike 查詢失敗", { error: String(error) });
      await ctx.reply("YouBike 資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default ybikeSkill;
