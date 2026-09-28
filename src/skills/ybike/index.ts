import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bike";

interface BikeStation {
  StationUID: string;
  StationID: string;
  StationName?: { Zh_tw?: string; En?: string };
  StationAddress?: { Zh_tw?: string };
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
  const res = await fetch(TDX_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`TDX 認證失敗（HTTP ${res.status}）`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
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

const ybikeSkill: SkillDefinition = {
  id: "ybike",
  name: "YouBike 即時車位",
  description: {
    zh: "查詢 YouBike 站點即時可借可還數量（需 TDX API key，可與火車技能共用）。",
    en: "Live YouBike station availability (requires TDX API key).",
    ja: "YouBike の空き状況を調べます（TDX API キーが必要）。",
  },
  usage: {
    zh: "YouBike 台北車站",
    en: "YouBike Taipei Main Station",
    ja: "YouBike 台北駅",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "YouBike",
  triggerAliases: ["ubike", "微笑單車", "單車"],
  fields: [
    { key: "tdxClientId", label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" }, hint: "至 https://tdx.transportdata.tw 註冊取得，可與火車技能共用" },
    { key: "tdxClientSecret", label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" }, secret: true },
    { key: "city", label: { zh: "預設縣市", en: "Default city", ja: "既定の都市" }, hint: "例如 台北；指令中也可直接指定（YouBike 高雄 巨蛋）" },
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
    const city = matchCity(ctx.args, CITIES[(ctx.config.city || "台北").trim()] ?? "Taipei");
    const keyword = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|YouBike|ubike|微笑單車|單車|腳踏車|車位|站|的/gi, " ")
      .replace(/台北|臺北|新北|桃園|新竹|苗栗|台中|臺中|嘉義|台南|臺南|高雄|屏東|宜蘭|花蓮|台東|臺東/g, " ")
      .trim();
    if (!keyword) {
      await ctx.reply("請指定站名或路名，例如：阿寶請幫忙 YouBike 台北車站");
      return;
    }
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
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
      const rows = mergeAvailability(stations, avail)
        .filter((s) => s.name.includes(keyword) || s.address.includes(keyword))
        .slice(0, 8);
      if (rows.length === 0) {
        await ctx.reply(`在${city}查無「${keyword}」相關站點，請換個站名或路名試試。`);
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
