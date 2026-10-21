import { logger } from "@lw/logger";
import { fetchJson as netFetchJson } from "@lw/net";
import { nowInTz } from "@lw/time";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "@lw/skills/types";

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Air";

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
    { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 },
  );
}

/** 航空公司中文名 → IATA 代碼（「長榮100」用；代碼可直接打）。 */
export const AIRLINES: Record<string, string> = {
  華航: "CI",
  中華航空: "CI",
  長榮: "BR",
  長榮航空: "BR",
  星宇: "JX",
  星宇航空: "JX",
  虎航: "IT",
  台灣虎航: "IT",
  立榮: "B7",
  華信: "AE",
  國泰: "CX",
  日航: "JL",
  全日空: "NH",
  大韓: "KE",
  韓亞: "OZ",
  新航: "SQ",
  泰航: "TG",
  越航: "VN",
  菲航: "PR",
  馬航: "MH",
  阿聯酋: "EK",
  卡達: "QR",
  澳航: "QF",
  聯合: "UA",
  達美: "DL",
  美國航空: "AA",
  加拿大航空: "AC",
  英航: "BA",
  法航: "AF",
  荷航: "KL",
  漢莎: "LH",
  土航: "TK",
};

export interface FlightNo {
  airline: string;
  number: string;
}

/**
 * 解析班號（CI100 / CI 100 / BR-1234 / 長榮100）。
 * 純代號回傳 airline 原文（大寫化）；中文名走 AIRLINES 對照。
 */
export function parseFlightNo(text: string): FlightNo | null {
  const cleaned = text.replace(/請幫忙|請幫|幫忙|查詢|查一下|航班|班機|動態|訂閱|取消|退訂|清單|列表|的/gi, " ");
  const m = /([A-Za-z]{2})\s*-?\s*(\d{1,4})\b/.exec(cleaned.toUpperCase());
  if (m) return { airline: m[1], number: m[2].replace(/^0+/, "") || "0" };
  const names = Object.keys(AIRLINES).sort((a, b) => b.length - a.length);
  for (const n of names) {
    const idx = cleaned.indexOf(n);
    if (idx < 0) continue;
    const num = /(\d{1,4})/.exec(cleaned.slice(idx + n.length));
    if (num) return { airline: AIRLINES[n], number: num[1].replace(/^0+/, "") || "0" };
  }
  return null;
}

const FLIGHT_CONTEXT = ["班機", "航班", "起飛", "降落", "到達", "抵達", "延誤", "誤點", "動態", "到了沒", "起飛了沒", "降落了沒"];

/**
 * 無前綴航班意圖偵測（「CI100到了沒」）。班號＋情境關鍵字才命中， bare 班號不搶。
 */
export function parseFlightIntent(text: string): FlightNo | null {
  const fn = parseFlightNo(text);
  if (!fn) return null;
  if (FLIGHT_CONTEXT.some((k) => text.includes(k))) return fn;
  return null;
}

/** 出境/入境方向偵測（都要或都不要 = 雙向）。 */
export function parseDirection(text: string): "dep" | "arr" | "both" {
  const dep = /出境|離境|起飛|出發/.test(text);
  const arr = /入境|到達|抵達|降落|到達/.test(text);
  if (dep && !arr) return "dep";
  if (arr && !dep) return "arr";
  return "both";
}

interface FidsRecord {
  FlightDate?: string;
  FlightNumber?: string;
  AirlineID?: string;
  DepartureAirportID?: string;
  ArrivalAirportID?: string;
  ScheduleDepartureTime?: string;
  EstimatedDepartureTime?: string;
  ActualDepartureTime?: string;
  DepartureRemark?: string;
  ScheduleArrivalTime?: string;
  EstimatedArrivalTime?: string;
  ActualArrivalTime?: string;
  ArrivalRemark?: string;
  Terminal?: string;
  Gate?: string;
  BaggageClaim?: string;
  IsCargo?: boolean;
  UpdateTime?: string;
}

export interface FlightStatus {
  direction: "dep" | "arr";
  date: string;
  airline: string;
  number: string;
  from: string;
  to: string;
  scheduled: string;
  estimated: string;
  actual: string;
  remark: string;
  terminal: string;
  gate: string;
  extra: string;
}

const AIRPORTS: Record<string, string> = {
  TPE: "桃園",
  TSA: "松山",
  KHH: "高雄",
  HND: "東京羽田",
  NRT: "東京成田",
  KIX: "大阪",
  ICN: "首爾仁川",
  HKG: "香港",
  SIN: "新加坡",
  BKK: "曼谷",
};

function airportName(code: string): string {
  return AIRPORTS[code] ?? code;
}

function pick(record: FidsRecord, ...keys: Array<keyof FidsRecord>): string {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** FIDS 原始記錄 → 顯示用狀態（出境/入境分開取欄位）。 */
export function toStatus(record: FidsRecord, direction: "dep" | "arr"): FlightStatus {
  const airline = record.AirlineID ?? "";
  const number = (record.FlightNumber ?? "").replace(/^0+/, "");
  if (direction === "dep") {
    return {
      direction,
      date: record.FlightDate ?? "",
      airline,
      number,
      from: record.DepartureAirportID ?? "",
      to: record.ArrivalAirportID ?? "",
      scheduled: pick(record, "ScheduleDepartureTime"),
      estimated: pick(record, "EstimatedDepartureTime"),
      actual: pick(record, "ActualDepartureTime"),
      remark: pick(record, "DepartureRemark"),
      terminal: record.Terminal ?? "",
      gate: record.Gate ?? "",
      extra: record.BaggageClaim ? `行李轉盤 ${record.BaggageClaim}` : "",
    };
  }
  return {
    direction,
    date: record.FlightDate ?? "",
    airline,
    number,
    from: record.DepartureAirportID ?? "",
    to: record.ArrivalAirportID ?? "",
    scheduled: pick(record, "ScheduleArrivalTime"),
    estimated: pick(record, "EstimatedArrivalTime"),
    actual: pick(record, "ActualArrivalTime"),
    remark: pick(record, "ArrivalRemark"),
    terminal: record.Terminal ?? "",
    gate: record.Gate ?? "",
    extra: record.BaggageClaim ? `行李轉盤 ${record.BaggageClaim}` : "",
  };
}

function minutesOf(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function hm(iso: string): string {
  if (!iso) return "—";
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso.slice(0, 16);
}

/** 狀態摘要（準時／延誤 X 分／取消／時間更改；供顯示與簽章共用）。 */
export function statusSummary(s: FlightStatus): string {
  const remark = s.remark || "";
  if (/取消|CANCEL/i.test(remark)) return "取消";
  if (/轉降|DIVERT/i.test(remark)) return "轉降";
  const sch = minutesOf(s.scheduled);
  const est = minutesOf(s.estimated);
  if (sch !== null && est !== null) {
    const diff = Math.round((est - sch) / 60_000);
    if (diff >= 5) return `延誤${diff}分`;
    if (diff <= -5) return `提早${Math.abs(diff)}分`;
  }
  if (/延誤|DELAY/i.test(remark)) return "延誤";
  if (/更改|CHANGE/i.test(remark)) return "時間更改";
  return "準時";
}

/** 異動簽章（remark＋預估＋登機門＋航廈＋實際時間；變了才推播）。 */
export function statusSignature(s: FlightStatus): string {
  return [s.remark, s.estimated, s.gate, s.terminal, s.actual, statusSummary(s)].join("|");
}

export function formatFlight(s: FlightStatus): string {
  const dir = s.direction === "dep" ? "出境" : "入境";
  const route =
    s.direction === "dep"
      ? `${airportName(s.from)} → ${airportName(s.to)}`
      : `${airportName(s.from)} → ${airportName(s.to)}`;
  const lines = [
    `${s.airline}${s.number}（${dir} ${s.date}）${route}`,
    `表定 ${hm(s.scheduled)} → 預估 ${hm(s.estimated)}［${statusSummary(s)}］`,
  ];
  const extra = [
    s.actual ? `實際 ${hm(s.actual)}` : "",
    s.terminal ? `航廈 ${s.terminal}` : "",
    s.gate ? `登機門 ${s.gate}` : "",
    s.extra,
  ].filter(Boolean);
  if (extra.length > 0) lines.push(extra.join("・"));
  if (s.remark) lines.push(`備註 ${s.remark}`);
  return lines.join("\n");
}

async function queryFids(
  direction: "dep" | "arr",
  airline: string,
  number: string,
  token: string,
): Promise<FidsRecord[]> {
  const endpoint = direction === "dep" ? "Departure" : "Arrival";
  const filter = encodeURIComponent(`FlightNumber eq '${number}'`);
  const data = await tdxGet<FidsRecord[]>(
    `${TDX_BASE}/FIDS/Airport/${endpoint}?$filter=${filter}&$top=30&$format=JSON`,
    token,
  );
  const list = Array.isArray(data) ? data : [];
  // 同班號可能有多家共掛（codeshare）：優先指定航空，否則全留
  const exact = list.filter((r) => (r.AirlineID ?? "").toUpperCase() === airline.toUpperCase());
  return (exact.length > 0 ? exact : list).slice(0, 3);
}

/** 查指定航班雙向（或單向）即時動態。 */
export async function lookupFlight(
  airline: string,
  number: string,
  direction: "dep" | "arr" | "both",
  token: string,
): Promise<FlightStatus[]> {
  const dirs = direction === "both" ? (["dep", "arr"] as const) : [direction];
  const out: FlightStatus[] = [];
  for (const d of dirs) {
    const records = await queryFids(d, airline, number, token);
    for (const r of records) out.push(toStatus(r, d));
  }
  return out;
}

const TASK = "flight-watch";
const MAX_SUBS = 5;

interface FlightSub {
  airline: string;
  number: string;
  direction: "dep" | "arr" | "both";
  label: string;
  lastSig: string;
  done: boolean;
  /** 出發日期（YYYY-MM-DD；缺省 = 當天即查）。 */
  date?: string;
  /** 同行程共用 id（行程指令建立）。 */
  tripId?: string;
  /** 行程顯示名。 */
  tripLabel?: string;
}

/** 今天 YYYY-MM-DD（設定時區）。 */
export function todayYmd(now = nowInTz()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function addDaysYmd(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t)) return ymd;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 從文字找第一個日期（M/D、M-D、X月X日）→ YYYY-MM-DD（已過走次年）。
 * 回傳日期與吃掉的原文片段（供行程解析剝除）。
 */
export function parseFlightDate(text: string, today: string): { ymd: string; matched: string } | null {
  const y = Number(today.slice(0, 4));
  const p = (n: number): string => String(n).padStart(2, "0");
  const roll = (mo: number, d: number): string | null => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let ymd = `${y}-${p(mo)}-${p(d)}`;
    if (ymd < today) ymd = `${y + 1}-${p(mo)}-${p(d)}`;
    return ymd;
  };
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?/.exec(text);
  if (cn) {
    const ymd = roll(Number(cn[1]), Number(cn[2]));
    if (ymd) return { ymd, matched: cn[0] };
  }
  const md = /(\d{1,2})[\/\-](\d{1,2})/.exec(text);
  if (md) {
    const ymd = roll(Number(md[1]), Number(md[2]));
    if (ymd) return { ymd, matched: md[0] };
  }
  return null;
}

export interface TripLeg {
  flight: FlightNo;
  date: string | null;
}

/**
 * 解析行程敘述（「11/18 JX715 11/24 JX716 東京行」）→ 航段列＋行程名。
 * 日期與班號按出現順序配對（前後皆可）；剩餘文字為行程名（可無）。
 */
export function parseTrip(text: string, today: string): { legs: TripLeg[]; name: string } {
  const cleaned = text.replace(/請幫忙|請幫|幫忙|查詢|查一下|航班|班機|動態|訂閱|行程|取消|退訂|清單|列表|的|出境|入境|出發|回程|去程/gi, " ");
  const tokens = cleaned.split(/[\s、，,＋+]+/).map((t) => t.trim()).filter(Boolean);
  const legs: TripLeg[] = [];
  let pendingDate: string | null = null;
  let pendingFlight: FlightNo | null = null;
  const consumed: string[] = [];
  const eat = (token: string, kind: "date" | "flight", value: { ymd: string; matched: string } | FlightNo): void => {
    consumed.push(token);
    if (kind === "date") {
      const ymd = (value as { ymd: string }).ymd;
      if (pendingFlight) {
        legs.push({ flight: pendingFlight, date: ymd });
        pendingFlight = null;
      } else {
        pendingDate = ymd;
      }
    } else {
      const flight = value as FlightNo;
      if (pendingDate) {
        legs.push({ flight, date: pendingDate });
        pendingDate = null;
      } else {
        if (pendingFlight) legs.push({ flight: pendingFlight, date: null });
        pendingFlight = flight;
      }
    }
  };
  for (const token of tokens) {
    const d = parseFlightDate(token, today);
    if (d) {
      eat(token, "date", d);
      continue;
    }
    const fn = parseFlightNo(token);
    if (fn) {
      eat(token, "flight", fn);
      continue;
    }
  }
  if (pendingFlight) legs.push({ flight: pendingFlight, date: pendingDate });
  else if (pendingDate && legs.length > 0 && legs[legs.length - 1].date === null) {
    legs[legs.length - 1].date = pendingDate;
  }
  const consumedSet = new Set(consumed);
  const name = tokens
    .filter((t) => !consumedSet.has(t))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { legs, name };
}

/** 該訂閱今天要不要查（無日期天天查；有日期只查前一天～後一天）。 */
export function shouldPoll(sub: Pick<FlightSub, "date">, today: string): boolean {
  if (!sub.date) return true;
  return today >= addDaysYmd(sub.date, -1) && today <= addDaysYmd(sub.date, 1);
}

/** 行程是否已過期（出發日＋1 之後 → 自動結案）。 */
export function isTripOver(sub: Pick<FlightSub, "date">, today: string): boolean {
  return !!sub.date && today > addDaysYmd(sub.date, 1);
}

interface FlightState {
  subs: FlightSub[];
}

function readSubs(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): FlightSub[] {
  const st = ctx.taskState(TASK) as Partial<FlightState> | undefined;
  return Array.isArray(st?.subs) ? (st.subs as FlightSub[]) : [];
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "15");
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : 15;
}

const flightStatusSkill: SkillDefinition = {
  id: "flight-status",
  name: "航班動態",
  description: {
    zh: "班機號查詢即時動態（起降時間/延誤/登機門），可訂閱異動通知、組旅程追蹤多段航班（需 TDX API key）。",
    en: "Live flight status by flight number with change alerts and trip tracking (requires TDX API key).",
    ja: "便名で運航状況を查詢、変更を通知（TDX API キーが必要）。",
  },
  usage: {
    zh: "航班 CI100；航班 長榮100 出境；航班 訂閱 JX715 11/18；航班 行程 11/18 JX715 11/24 JX716 東京行；航班 清單；航班 取消 CI100",
    en: "flight CI100; flight subscribe JX715 11/18; flight list; flight cancel CI100",
    ja: "航班 CI100",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "航班",
  naturalKeywords: ["航班動態", "班機動態", "航班延誤", "航班查詢"],
  triggerAliases: ["班機", "航班查詢", "flightstatus"],
  fields: [
    {
      key: "tdxClientId",
      label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" },
      hint: { zh: "至 https://tdx.transportdata.tw 註冊取得，可與火車技能共用", en: "Register at https://tdx.transportdata.tw", ja: "https://tdx.transportdata.tw で登録" },
    },
    {
      key: "tdxClientSecret",
      label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" },
      hint: "同上",
      secret: true,
    },
    {
      key: "pollMinutes",
      label: { zh: "異動檢查間隔（分鐘）", en: "Change check interval (min)", ja: "変更チェック間隔（分）" },
      hint: "預設 15；1–120（太短會消耗 TDX 配額）",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(`${TDX_BASE}/FIDS/Airport/Arrival?$top=1&$format=JSON`, {
        signal: AbortSignal.timeout(15_000),
      });
      // 401 表示路徑正確、只缺 token；其他 2xx/4xx 亦視為服務存活
      return [{ name: "TDX FIDS", ok: res.status < 500, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "TDX FIDS", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const clientId = (ctx.config.tdxClientId || "").trim();
    const clientSecret = (ctx.config.tdxClientSecret || "").trim();
    if (!clientId || !clientSecret) {
      await ctx.reply("航班動態技能尚未設定 TDX API key，請到技能設定填寫（可與火車技能共用同一組）。");
      return;
    }
    const args = ctx.args.trim();
    const subs = readSubs(ctx);
    const minutes = pollMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };

    // 取消訂閱（航班／整團行程）
    if (/^(取消|退訂|停止|刪除)/.test(args)) {
      if (subs.length === 0) {
        await ctx.reply("目前沒有航班異動訂閱。");
        return;
      }
      const target = args.replace(/請幫忙|請幫|幫忙|取消|退訂|停止|刪除|全部|的/g, " ").trim().toUpperCase();
      if (/全部/.test(args) && !parseFlightNo(target)) {
        for (const w of ctx.watches()) ctx.unwatch(w.id);
        await ctx.reply(`已取消全部 ${subs.length} 個航班訂閱。`);
        return;
      }
      // 取消行程 <關鍵字>：整團砍掉
      if (/^(取消行程|退訂行程)/.test(args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim())) {
        const kw = args
          .replace(/請幫忙|請幫|幫忙|取消行程|退訂行程|取消|退訂|停止|刪除|的/g, " ")
          .trim();
        const hit = subs.filter((s) => s.tripId && (s.tripLabel ?? "").includes(kw));
        if (hit.length === 0) {
          await ctx.reply(`找不到行程「${kw}」，請用「航班 清單」查看。`);
          return;
        }
        const ids = new Set(hit.map((s) => s.tripId));
        const names = [...new Set(hit.map((s) => s.tripLabel ?? s.label))].join("、");
        const kept = subs.filter((s) => !ids.has(s.tripId));
        subs.splice(0, subs.length, ...kept);
        if (subs.length === 0) {
          for (const w of ctx.watches()) ctx.unwatch(w.id);
        } else {
          ctx.watch({ ...watchOpts, state: { subs } });
        }
        await ctx.reply(`已取消行程：${names}（${hit.length} 段）`);
        return;
      }
      const fn = parseFlightNo(target);
      const idx = fn
        ? subs.findIndex((s) => s.airline === fn.airline && s.number === fn.number)
        : subs.findIndex((s) => s.label.includes(target) || target.includes(s.label));
      if (idx < 0) {
        await ctx.reply(`找不到「${target}」的訂閱，請用「航班 清單」查看。`);
        return;
      }
      const removed = subs[idx];
      subs.splice(idx, 1);
      if (subs.length === 0) {
        for (const w of ctx.watches()) ctx.unwatch(w.id);
        await ctx.reply(`已取消：${removed.label}（已無訂閱，停止檢查）`);
        return;
      }
      ctx.watch({ ...watchOpts, state: { subs } });
      await ctx.reply(`已取消：${removed.label}\n剩 ${subs.length} 個訂閱。`);
      return;
    }

    // 訂閱清單（行程成團顯示）
    if (/^(清單|列表|list)$/i.test(args)) {
      if (subs.length === 0) {
        await ctx.reply("目前沒有航班訂閱。用法：阿寶請幫忙 航班 訂閱 CI100");
        return;
      }
      const singles = subs.filter((s) => !s.tripId);
      const trips = new Map<string, FlightSub[]>();
      for (const s of subs) {
        if (!s.tripId) continue;
        const arr = trips.get(s.tripId) ?? [];
        arr.push(s);
        trips.set(s.tripId, arr);
      }
      const lines: string[] = singles.map(
        (s) => `・${s.label}${s.date ? `（${s.date.slice(5)}）` : ""}${s.done ? "（已結束）" : ""}`,
      );
      for (const group of trips.values()) {
        const label = group[0].tripLabel ?? "行程";
        lines.push(`🧳 ${label}：`);
        for (const s of group) {
          lines.push(`　・${s.label}${s.date ? `（${s.date.slice(5)}）` : ""}${s.done ? "（已結束）" : ""}`);
        }
      }
      await ctx.reply(`航班訂閱（${subs.length}）：\n${lines.join("\n")}`);
      return;
    }

    // 行程：多段一次訂（「航班 行程 11/18 JX715 11/24 JX716 東京行」）
    if (/^行程/.test(args)) {
      const today = todayYmd();
      const { legs, name } = parseTrip(args, today);
      if (legs.length === 0) {
        await ctx.reply("用法：阿寶請幫忙 航班 行程 11/18 JX715 11/24 JX716（可加行程名）");
        return;
      }
      if (subs.length + legs.length > MAX_SUBS) {
        await ctx.reply(`行程共 ${legs.length} 段，加上現有訂閱會超過上限（${MAX_SUBS} 個），請先取消舊的。`);
        return;
      }
      const tripId = `t${Date.now().toString(36)}`;
      const tripLabel =
        name || legs.map((l) => `${l.flight.airline}${l.flight.number}${l.date ? l.date.slice(5) : ""}`).join("＋");
      const direction = parseDirection(args);
      let skipped = 0;
      let added = 0;
      for (const leg of legs) {
        if (subs.some((s) => s.airline === leg.flight.airline && s.number === leg.flight.number && (s.date ?? null) === leg.date)) {
          skipped++;
          continue;
        }
        added++;
        subs.push({
          airline: leg.flight.airline,
          number: leg.flight.number,
          direction,
          label: `${leg.flight.airline}${leg.flight.number}`,
          lastSig: "",
          done: false,
          ...(leg.date ? { date: leg.date } : {}),
          tripId,
          tripLabel,
        });
      }
      ctx.watch({ ...watchOpts, state: { subs } });
      const legLines = legs.map(
        (l) => `・${l.flight.airline}${l.flight.number}${l.date ? `（${l.date.slice(5)}出發，前一天開始追蹤）` : ""}`,
      );
      logger.info("已建立航班行程", { chat: ctx.chat, tripLabel, legs: legs.length });
      if (added === 0) {
        await ctx.reply("這些航班都已經訂閱過了（可用「航班 清單」查看）。");
        return;
      }
      await ctx.reply(`已建立行程「${tripLabel}」：\n${legLines.join("\n")}${skipped > 0 ? `\n（${skipped} 段已訂閱過，略過）` : ""}\n（「航班 取消行程 ${tripLabel}」可整團取消）`);
      return;
    }

    // 訂閱異動通知（可帶日期：「航班 訂閱 JX715 11/18」）
    if (/^訂閱/.test(args)) {
      const fn = parseFlightNo(args);
      if (!fn) {
        await ctx.reply("用法：阿寶請幫忙 航班 訂閱 CI100（可加日期：航班 訂閱 JX715 11/18；取消：航班 取消 CI100）");
        return;
      }
      if (subs.length >= MAX_SUBS) {
        await ctx.reply(`航班訂閱已達上限（${MAX_SUBS} 個），請先取消舊的。`);
        return;
      }
      if (subs.some((s) => s.airline === fn.airline && s.number === fn.number)) {
        await ctx.reply("已經訂閱過這班了（可用「航班 清單」查看）。");
        return;
      }
      const direction = parseDirection(args);
      const label = `${fn.airline}${fn.number}`;
      const today = todayYmd();
      const dateHit = parseFlightDate(args, today);
      const date = dateHit ? dateHit.ymd : undefined;
      // 未來日期：FIDS 還沒有這班，先建檔等窗口（不即時驗證）
      if (date && !shouldPoll({ date }, today)) {
        subs.push({ airline: fn.airline, number: fn.number, direction, label, lastSig: "", done: false, date });
        ctx.watch({ ...watchOpts, state: { subs } });
        logger.info("已訂閱航班（未來）", { chat: ctx.chat, label, date });
        await ctx.reply(`已訂閱 ${label}（${date.slice(5)}）異動通知，將於出發前一天開始追蹤。`);
        return;
      }
      try {
        const token = await getToken(clientId, clientSecret);
        const current = await lookupFlight(fn.airline, fn.number, direction, token);
        if (current.length === 0) {
          await ctx.reply(`目前查不到 ${label} 的動態（可能非今日航班），請確認班號。`);
          return;
        }
        const sub: FlightSub = {
          airline: fn.airline,
          number: fn.number,
          direction,
          label,
          lastSig: current.map(statusSignature).join(";"),
          done: false,
          ...(date ? { date } : {}),
        };
        subs.push(sub);
        ctx.watch({ ...watchOpts, state: { subs } });
        logger.info("已訂閱航班異動", { chat: ctx.chat, label });
        await ctx.reply(`已訂閱 ${label} 異動通知（延誤/取消/登機門變更時推播，${minutes} 分鐘檢查一次）：\n${current.map(formatFlight).join("\n\n")}`);
      } catch (error) {
        logger.warn("航班訂閱失敗", { label, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply(`訂閱失敗：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // 即時查詢
    const fn = parseFlightNo(ctx.args);
    if (!fn) {
      await ctx.reply("請指定班號，例如：阿寶請幫忙 航班 CI100（或：航班 長榮100 出境）");
      return;
    }
    try {
      const token = await getToken(clientId, clientSecret);
      const rows = await lookupFlight(fn.airline, fn.number, parseDirection(ctx.args), token);
      if (rows.length === 0) {
        await ctx.reply(`目前查不到 ${fn.airline}${fn.number} 的動態（可能非今日航班），請確認班號。`);
        return;
      }
      logger.info("航班動態查詢", { flight: `${fn.airline}${fn.number}`, count: rows.length });
      await ctx.reply(rows.map(formatFlight).join("\n\n"));
    } catch (error) {
      logger.error("航班動態查詢失敗", { error: String(error) });
      await ctx.reply("航班資料來源目前無法使用，請稍後再試。");
    }
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const subs = (Array.isArray(ctx.state?.subs) ? ctx.state.subs : []) as FlightSub[];
    const active = subs.filter((s) => !s.done);
    if (active.length === 0) return;

    // 先過窗口：太早不查、過期結案（這批不需 token 也不打 TDX）
    const today = todayYmd();
    let changed = false;
    const due: FlightSub[] = [];
    for (const sub of active) {
      if (sub.date && !shouldPoll(sub, today)) {
        if (isTripOver(sub, today) && !sub.done) {
          sub.done = true;
          changed = true;
          logger.info("航班追蹤到期結案", { flight: sub.label, date: sub.date });
        }
        continue;
      }
      due.push(sub);
    }
    if (due.length === 0) {
      if (changed) await ctx.saveState({ subs });
      return;
    }
    const clientId = ctx.config.tdxClientId?.trim();
    const clientSecret = ctx.config.tdxClientSecret?.trim();
    if (!clientId || !clientSecret) {
      logger.warn("航班推播跳過：未設定 TDX key");
      if (changed) await ctx.saveState({ subs });
      return;
    }

    let token: string;
    try {
      token = await getToken(clientId, clientSecret);
    } catch (error) {
      logger.warn("航班推播跳過：TDX 認證失敗", { error: error instanceof Error ? error.message : String(error) });
      if (changed) await ctx.saveState({ subs });
      return;
    }

    for (const sub of due) {
      try {
        const rows = await lookupFlight(sub.airline, sub.number, sub.direction, token);
        if (rows.length === 0) continue;
        const sig = rows.map(statusSignature).join(";");
        if (sig === sub.lastSig) continue;
        const first = sub.lastSig === "";
        sub.lastSig = sig;
        changed = true;
        const icon = sub.direction === "dep" ? "🛫" : sub.direction === "arr" ? "🛬" : "✈️";
        const title = sub.tripLabel ? `【${sub.tripLabel}】${sub.label}` : sub.label;
        const finished = rows.some((r) => r.actual);
        if (finished) sub.done = true;
        await ctx.reply(
          `${icon} ${title}${first ? " 開始追蹤" : " 異動"}：\n${rows.map(formatFlight).join("\n\n")}${finished ? "\n（航班已結束，停止追蹤）" : ""}`,
        );
        logger.info("航班異動推播", { flight: sub.label });
      } catch (error) {
        logger.warn("航班輪詢失敗", {
          flight: `${sub.airline}${sub.number}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (changed) await ctx.saveState({ subs });
  },
};

export default flightStatusSkill;
