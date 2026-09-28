import { logger } from "../../logger.js";
import { nowInTz } from "../../time.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition } from "../types.js";

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/TRA";

interface Station {
  StationID: string;
  StationName: { Zh_tw: string; En: string };
}

interface ODStopTime {
  StationID: string;
  StationName: { Zh_tw: string };
  ArrivalTime: string;
  DepartureTime: string;
}

interface ODEntry {
  TrainDate: string;
  DailyTrainInfo: {
    TrainNo: string;
    TrainTypeName: { Zh_tw: string };
    StartingStationName: { Zh_tw: string };
    EndingStationName: { Zh_tw: string };
  };
  OriginStopTime: ODStopTime;
  DestinationStopTime: ODStopTime;
}

let tokenCache: { token: string; expires: number } | null = null;
let stationCache: Station[] | null = null;
const STATIONS_CACHE = "tra-stations";

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

async function getStations(token: string, ttlMs: number): Promise<Station[]> {
  if (stationCache) return stationCache;
  const cached = readCache<Station[]>(STATIONS_CACHE, ttlMs);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    stationCache = cached;
    return cached;
  }
  const res = await fetch(`${TDX_BASE}/Station?$format=JSON`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`取得車站清單失敗（HTTP ${res.status}）`);
  const stations = (await res.json()) as Station[];
  stationCache = stations;
  writeCache(STATIONS_CACHE, stations);
  return stations;
}

function normalize(name: string): string {
  return name.trim().replace(/台/g, "臺").replace(/站$/, "");
}

function findStation(stations: Station[], name: string): Station | undefined {
  const target = normalize(name);
  if (!target) return undefined;
  return (
    stations.find((s) => s.StationName.Zh_tw === target) ||
    stations.find((s) => normalize(s.StationName.Zh_tw) === target) ||
    stations.find((s) => s.StationName.Zh_tw.startsWith(target)) ||
    stations.find((s) => (s.StationName.En || "").toLowerCase() === name.trim().toLowerCase())
  );
}

function pad(n: number): string {
  return ("0" + n).slice(-2);
}

/** 依設定時區解析「今天/明天/後天」與日期字串。 */
function parseDate(input: string): Date | null {
  const now = nowInTz();
  if (!input) return null;
  if (/今天|今日/.test(input)) return now;
  if (/明天|明日/.test(input)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (/後天/.test(input)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const ymd = input.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const md = input.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (md) return new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
  return null;
}

function extractTime(text: string): string {
  const m = text.match(/(\d{1,2})[:：](\d{2})/);
  if (m) return `${pad(Number(m[1]))}:${pad(Number(m[2]))}`;
  return "";
}

async function queryTimetable(
  token: string,
  fromId: string,
  toId: string,
  date: Date,
): Promise<ODEntry[]> {
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const url = `${TDX_BASE}/DailyTimetable/OD/${fromId}/to/${toId}/${dateStr}?$format=JSON`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`查詢時刻表失敗（HTTP ${res.status}）${body ? `：${body.slice(0, 120)}` : ""}`);
  }
  return (await res.json()) as ODEntry[];
}

function formatReply(
  fromName: string,
  toName: string,
  date: Date,
  rows: ODEntry[],
  afterTime: string,
): string {
  const cutoff = afterTime; // 已由呼叫端決定（未指定時為「現在」）
  const filtered = rows
    .map((row) => ({
      type: row.DailyTrainInfo.TrainTypeName?.Zh_tw ?? "",
      no: row.DailyTrainInfo.TrainNo,
      dep: row.OriginStopTime.DepartureTime || row.OriginStopTime.ArrivalTime,
      arr: row.DestinationStopTime.ArrivalTime || row.DestinationStopTime.DepartureTime,
    }))
    .filter((x) => !cutoff || x.dep >= cutoff)
    .sort((a, b) => a.dep.localeCompare(b.dep))
    .slice(0, 8);

  const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
  if (filtered.length === 0) {
    return `${fromName} → ${toName}（${dateStr}）沒有符合的班次${cutoff ? `（${cutoff} 之後）` : ""}。`;
  }
  const lines = filtered.map((x) => `${x.dep} → ${x.arr}  ${x.type} ${x.no}`);
  return `${fromName} → ${toName}（${dateStr}）${cutoff ? `${cutoff} 之後 ` : ""}共 ${filtered.length} 班：\n${lines.join("\n")}`;
}

const trainSkill: SkillDefinition = {
  id: "train",
  name: "火車時刻表",
  description: {
    zh: "查詢台鐵時刻表（需 TDX API key）。",
    en: "TRA timetable (requires TDX API key).",
    ja: "台鉄の時刻表（TDX API キーが必要）。",
  },
  usage: {
    zh: "火車 台北 到 高雄 明天 08:00",
    en: "train Taipei to Kaohsiung",
    ja: "火車 台北 高雄 明日 08:00",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "火車",
  fields: [
    {
      key: "tdxClientId",
      label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" },
      hint: { zh: "至 https://tdx.transportdata.tw 註冊取得", en: "Register at https://tdx.transportdata.tw", ja: "https://tdx.transportdata.tw で登録" },
    },
    { key: "tdxClientSecret", label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" }, secret: true },
    {
      key: "cacheTtl",
      label: { zh: "站點快取時間（TTL）", en: "Station cache TTL", ja: "駅キャッシュ TTL" },
      hint: "預設 60 分鐘；可填 30（分鐘）、30m、2h、90s",
    },
  ],
  async run(ctx: SkillContext): Promise<void> {
    const clientId = ctx.config.tdxClientId?.trim();
    const clientSecret = ctx.config.tdxClientSecret?.trim();
    if (!clientId || !clientSecret) {
      await ctx.reply("火車時刻表技能尚未設定 TDX API key，請到設定頁填寫 Client ID / Secret。");
      return;
    }

    const raw = ctx.args.replace(/請幫忙|請幫|幫忙|查詢|查一下|時刻表|班次|火車|的|到|去|至/g, " ");
    const tokens = raw.split(/\s+/).filter(Boolean);
    const date = parseDate(ctx.args);
    const explicitTime = extractTime(ctx.args);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    const now = nowInTz();

    const token = await getToken(clientId, clientSecret);
    const stations = await getStations(token, ttlMs);

    // 站名：優先從原始文字中找出兩個已知站名
    const known = stations.filter((s) => ctx.args.includes(normalize(s.StationName.Zh_tw)));
    let fromName = known[0]?.StationName.Zh_tw;
    let toName = known[1]?.StationName.Zh_tw;

    if (!fromName || !toName) {
      const sepMatch = ctx.args.match(/([^\s]+)\s*(?:到|去|至|->|→)\s*([^\s]+)/);
      if (sepMatch) {
        const a = findStation(stations, sepMatch[1]);
        const b = findStation(stations, sepMatch[2]);
        if (a) fromName = a.StationName.Zh_tw;
        if (b) toName = b.StationName.Zh_tw;
      }
    }
    if (!fromName || !toName) {
      const found: string[] = [];
      for (const t of tokens) {
        const s = findStation(stations, t);
        if (s && !found.includes(s.StationName.Zh_tw)) found.push(s.StationName.Zh_tw);
        if (found.length >= 2) break;
      }
      fromName = fromName || found[0];
      toName = toName || found[1];
    }

    const from = fromName ? findStation(stations, fromName) : undefined;
    const to = toName ? findStation(stations, toName) : undefined;

    if (!from || !to) {
      await ctx.reply("請指定起點與終點站，例如：阿寶請幫忙 火車 台北 到 高雄 明天 08:00");
      return;
    }

    const targetDate = date ?? now;
    const isToday =
      targetDate.getFullYear() === now.getFullYear() &&
      targetDate.getMonth() === now.getMonth() &&
      targetDate.getDate() === now.getDate();
    // 未指定時間，且查的是今天 → 從現在時間起算；否則不設下限
    const afterTime =
      explicitTime ||
      (isToday ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : "");

    const trains = await queryTimetable(token, from.StationID, to.StationID, targetDate);
    const reply = formatReply(
      from.StationName.Zh_tw,
      to.StationName.Zh_tw,
      targetDate,
      trains,
      afterTime,
    );
    logger.info("火車時刻表查詢", { from: from.StationID, to: to.StationID, count: trains.length, after: afterTime });
    await ctx.reply(reply);
  },
};

export default trainSkill;
