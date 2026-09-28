import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import { fetchJson as netFetchJson } from "../../net.js";
import type { SkillContext, SkillDefinition, SkillHealth } from "../types.js";

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";

interface MetroStation {
  StationID: string;
  StationName?: { Zh_tw?: string; En?: string };
  StationAddress?: string;
  LocationCity?: string;
}

interface ODFare {
  OriginStationID?: string;
  OriginStationName?: { Zh_tw?: string };
  DestinationStationID?: string;
  DestinationStationName?: { Zh_tw?: string };
  Fares?: Array<{ TicketType?: string; FareClass?: string; Price?: number }>;
}

interface S2STime {
  OriginStationID?: string;
  DestinationStationID?: string;
  TravelTime?: number;
}

const OPERATORS: Record<string, string> = {
  台北: "TRTC",
  臺北: "TRTC",
  高雄: "KRTC",
  桃園: "TYMC",
  機捷: "TYMC",
  台中: "TMRT",
  臺中: "TMRT",
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

function norm(s: string): string {
  return s.trim().replace(/台/g, "臺").replace(/站$/, "");
}

export function matchOperator(args: string, fallback: string): string {
  for (const [name, code] of Object.entries(OPERATORS)) {
    if (args.includes(name)) return code;
  }
  return fallback;
}

export function findStationId(stations: MetroStation[], name: string): MetroStation | undefined {
  const target = norm(name);
  if (!target) return undefined;
  return (
    stations.find((s) => norm(s.StationName?.Zh_tw ?? "") === target) ||
    stations.find((s) => norm(s.StationName?.Zh_tw ?? "").startsWith(target)) ||
    stations.find((s) => norm(s.StationName?.Zh_tw ?? "").includes(target))
  );
}

/** 從 Headway 回傳中挑出方向與班距描述（欄位名稱各營運單位略有差異，採候選鍵掃描）。 */
export function formatHeadway(entry: Record<string, unknown>): string {
  const dirRaw = entry.Direction;
  const dir = dirRaw === 0 || dirRaw === "0" ? "去程" : dirRaw === 1 || dirRaw === "1" ? "返程" : String(dirRaw ?? "");
  const keys = [
    "HeadwayDesc",
    "HeadwayDescZh",
    "PeakHeadway",
    "OffPeakHeadway",
    "WeekdayHeadway",
    "HolidayHeadway",
    "Headway",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const v = entry[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") parts.push(String(v).trim());
  }
  const line = entry.LineName ?? entry.LineID ?? "";
  return `${line ? `${line}・` : ""}${dir ? `${dir}：` : ""}${parts.join("／") || "（無班距資料）"}`;
}

const metroSkill: SkillDefinition = {
  id: "metro",
  name: "捷運班距票價",
  description: {
    zh: "查詢捷運票價、行車時間、班距與車站（需 TDX API key，可與火車技能共用）。",
    en: "MRT fares, travel time, headways and stations (requires TDX API key).",
    ja: "MRT の運賃・所要時間・運行間隔・駅を調べます（TDX API キーが必要）。",
  },
  usage: {
    zh: "捷運 台北車站 到 西門",
    en: "捷運 Taipei Main Station to Ximen",
    ja: "捷運 台北駅 西門",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "捷運",
  triggerAliases: ["地鐵", "mrt", "北捷", "班距"],
  fields: [
    { key: "tdxClientId", label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" }, hint: "至 https://tdx.transportdata.tw 註冊取得，可與火車技能共用" },
    { key: "tdxClientSecret", label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" }, secret: true },
    { key: "operator", label: { zh: "預設捷運", en: "Default metro", ja: "既定の MRT" }, hint: "TRTC 台北 / KRTC 高雄 / TYMC 桃捷 / TMRT 台中，預設 TRTC" },
    { key: "cacheTtl", label: { zh: "站點快取時間（TTL）", en: "Cache TTL", ja: "キャッシュ TTL" }, hint: "預設 1 天；可填 60（分鐘）、12h" },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${TDX_BASE}/Station/TRTC?$format=JSON&$top=1`, {
        signal: AbortSignal.timeout(15_000),
      });
      return [{ name: "TDX Metro", ok: res.status < 500, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "TDX Metro", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const clientId = (ctx.config.tdxClientId || "").trim();
    const clientSecret = (ctx.config.tdxClientSecret || "").trim();
    if (!clientId || !clientSecret) {
      await ctx.reply("捷運技能尚未設定 TDX API key，請到技能設定填寫（可與火車技能共用同一組）。");
      return;
    }
    const op = matchOperator(ctx.args, (ctx.config.operator || "TRTC").trim() || "TRTC");
    const ttlMs = parseTtl(ctx.config.cacheTtl, 1440);

    // 班距查詢
    if (/班距|多久一班|幾分鐘一班|headway/i.test(ctx.args)) {
      try {
        const token = await getToken(clientId, clientSecret);
        const rows = await tdxGet<Record<string, unknown>[]>(`${TDX_BASE}/Headway/${op}?$format=JSON`, token);
        if (!Array.isArray(rows) || rows.length === 0) {
          await ctx.reply("目前查無班距資料。");
          return;
        }
        const lines = rows.slice(0, 8).map((r) => `・${formatHeadway(r)}`);
        await ctx.reply(`捷運班距（${op}）：\n${lines.join("\n")}`);
      } catch (error) {
        logger.error("捷運班距查詢失敗", { error: String(error) });
        await ctx.reply("捷運資料來源目前無法使用，請稍後再試。");
      }
      return;
    }

    const cleaned = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|捷運|地鐵|mrt|北捷|高捷|桃捷|中捷|班距|票價|車資|到|去|至|->|→|的/g, " ")
      .replace(/台北|臺北|高雄|桃園|台中|臺中/g, " ")
      .trim();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    try {
      const token = await getToken(clientId, clientSecret);
      const stationKey = `metro-stations-${op}`;
      let stations = readCache<MetroStation[]>(stationKey, ttlMs);
      if (!stations || stations.length === 0) {
        stations = await tdxGet<MetroStation[]>(`${TDX_BASE}/Station/${op}?$format=JSON`, token);
        writeCache(stationKey, stations);
      }
      const found = tokens
        .map((t) => findStationId(stations as MetroStation[], t))
        .filter((s): s is MetroStation => !!s);
      if (found.length >= 2) {
        const [from, to] = found;
        const [fares, times] = await Promise.all([
          tdxGet<ODFare[]>(`${TDX_BASE}/ODFare/${op}?$format=JSON`, token),
          tdxGet<S2STime[]>(`${TDX_BASE}/S2STravelTime/${op}?$format=JSON`, token).catch(() => [] as S2STime[]),
        ]);
        const fare = fares.find(
          (f) => f.OriginStationID === from.StationID && f.DestinationStationID === to.StationID,
        );
        const time = (times as S2STime[]).find(
          (t) => t.OriginStationID === from.StationID && t.DestinationStationID === to.StationID,
        );
        const price = fare?.Fares?.find((f) => f.Price !== undefined)?.Price
          ?? fare?.Fares?.[0]?.Price;
        const fromName = from.StationName?.Zh_tw ?? from.StationID;
        const toName = to.StationName?.Zh_tw ?? to.StationID;
        const parts = [`${fromName} → ${toName}`];
        if (price !== undefined) parts.push(`票價 $${price}`);
        if (time?.TravelTime !== undefined) parts.push(`行車約 ${time.TravelTime} 分`);
        if (parts.length === 1) parts.push("查無票價資料，請確認起訖站是否同線可直達。");
        logger.info("捷運票價查詢", { op, from: from.StationID, to: to.StationID });
        await ctx.reply(parts.join("\n"));
        return;
      }
      if (found.length === 1) {
        const s = found[0];
        await ctx.reply(
          `${s.StationName?.Zh_tw ?? s.StationID}（${s.StationID}）\n${s.StationAddress ?? ""}\n要查票價請說：捷運 ${s.StationName?.Zh_tw ?? ""} 到 ○○站`,
        );
        return;
      }
      await ctx.reply("請指定起點與終點站，例如：阿寶請幫忙 捷運 台北車站 到 西門");
    } catch (error) {
      logger.error("捷運查詢失敗", { error: String(error) });
      await ctx.reply("捷運資料來源目前無法使用，請稍後再試。");
    }
  },
};

export default metroSkill;
