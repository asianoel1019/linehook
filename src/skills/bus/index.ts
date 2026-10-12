import { logger } from "../../logger.js";
import { parseTtl, readCache, writeCache } from "../cache.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";
import { describeWatch } from "../watch.js";

const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BASE = "https://tdx.transportdata.tw/api/basic/v2/Bus";

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

interface Route {
  RouteUID: string;
  RouteName: { Zh_tw: string };
  DepartureStopNameZh?: string;
  DestinationStopNameZh?: string;
  Operators?: Array<{ OperatorName?: { Zh_tw?: string } }>;
}

interface StopOfRoute {
  Direction: number;
  RouteName?: { Zh_tw?: string };
  Stops?: Array<{ StopUID: string; StopID: string; StopName?: { Zh_tw?: string }; StopSequence: number }>;
}

interface Eta {
  PlateNumb?: string;
  Direction: number;
  StopUID?: string;
  StopName?: { Zh_tw?: string };
  StopSequence: number;
  EstimateTime?: number;
}

const CITIES: Array<{ match: string[]; city: string }> = [
  { match: ["臺北", "台北", "北市"], city: "Taipei" },
  { match: ["新北"], city: "NewTaipei" },
  { match: ["桃園"], city: "Taoyuan" },
  { match: ["臺中", "台中"], city: "Taichung" },
  { match: ["高雄"], city: "Kaohsiung" },
  { match: ["臺南", "台南"], city: "Tainan" },
  { match: ["基隆"], city: "Keelung" },
  { match: ["新竹市"], city: "Hsinchu" },
  { match: ["新竹"], city: "HsinchuCounty" },
  { match: ["苗栗"], city: "MiaoliCounty" },
  { match: ["彰化"], city: "ChanghuaCounty" },
  { match: ["南投"], city: "NantouCounty" },
  { match: ["雲林"], city: "YunlinCounty" },
  { match: ["嘉義市"], city: "Chiayi" },
  { match: ["嘉義"], city: "ChiayiCounty" },
  { match: ["屏東"], city: "PingtungCounty" },
  { match: ["宜蘭"], city: "YilanCounty" },
  { match: ["花蓮"], city: "HualienCounty" },
  { match: ["臺東", "台東"], city: "TaitungCounty" },
  { match: ["澎湖"], city: "PenghuCounty" },
  { match: ["金門"], city: "KinmenCounty" },
  { match: ["連江", "馬祖"], city: "LienchiangCounty" },
];

const DEFAULT_ORDER = ["Taipei", "NewTaipei", "Taoyuan", "Taichung", "Kaohsiung", "Tainan", "Keelung"];

const ROUTE_RE =
  /^[0-9A-Za-z]{1,8}$|^(紅|藍|綠|棕|橘|小|黃|幹線|跳蛙|F|市民|內科|懷恩|新幹線|先導)[0-9A-Za-z\u4e00-\u9fa5]{0,8}(公車|線)?$/;

function parseRoute(text: string): string {
  const cleaned = text.replace(/請幫忙|請幫|幫忙|查詢|查一下|動態|公車|客運|路線|現在|一下|的/g, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (CITIES.some((c) => c.match.some((m) => t === m))) continue;
    if (ROUTE_RE.test(t)) return t;
  }
  return "";
}

function parseCity(text: string): string {
  for (const c of CITIES) if (c.match.some((m) => text.includes(m))) return c.city;
  return "";
}

async function fetchRoutes(city: string, token: string, ttlMs: number): Promise<Route[]> {
  const cacheName = `bus-routes-${city}`;
  const cached = readCache<Route[]>(cacheName, ttlMs);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;
  const res = await fetch(`${TDX_BASE}/Route/City/${city}?$format=JSON`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`取得路線失敗（HTTP ${res.status}）`);
  const routes = (await res.json()) as Route[];
  writeCache(cacheName, routes);
  return routes;
}

function matchRoute(routes: Route[], name: string): Route | undefined {
  const norm = name.trim().toUpperCase();
  return (
    routes.find((r) => (r.RouteName?.Zh_tw ?? "").toUpperCase() === norm) ||
    routes.find((r) => (r.RouteName?.Zh_tw ?? "").toUpperCase().replace(/公車$/, "") === norm.replace(/公車$/, "")) ||
    routes.find((r) => (r.RouteName?.Zh_tw ?? "").toUpperCase().startsWith(norm))
  );
}

async function findRoute(
  routeName: string,
  token: string,
  ttlMs: number,
  preferCity: string,
): Promise<{ city: string; route: Route } | null> {
  const order = preferCity ? [preferCity, ...DEFAULT_ORDER.filter((c) => c !== preferCity)] : DEFAULT_ORDER;
  for (const city of order) {
    try {
      const routes = await fetchRoutes(city, token, ttlMs);
      const route = matchRoute(routes, routeName);
      if (route) return { city, route };
    } catch (error) {
      logger.warn("公車路線查詢失敗", { city, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return null;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 路線的站序（含快取；輪詢到站時重複使用，不重打 TDX）。 */
async function fetchStopOfRoute(city: string, routeKey: string, token: string, ttlMs: number): Promise<StopOfRoute[]> {
  const cacheName = `bus-sor-${city}-${routeKey}`;
  const cached = readCache<StopOfRoute[]>(cacheName, ttlMs);
  if (cached && Array.isArray(cached)) return cached;
  const data = await fetchJson<StopOfRoute[]>(
    `${TDX_BASE}/StopOfRoute/City/${city}/${encodeURIComponent(routeKey)}?$format=JSON`,
    token,
  );
  writeCache(cacheName, data);
  return Array.isArray(data) ? data : [];
}

function headsign(stops: StopOfRoute, route: Route): string {
  const list = (stops.Stops ?? []).slice().sort((a, b) => a.StopSequence - b.StopSequence);
  const last = list[list.length - 1]?.StopName?.Zh_tw;
  const first = list[0]?.StopName?.Zh_tw;
  return last || (stops.Direction === 0 ? route.DestinationStopNameZh : route.DepartureStopNameZh) || (first ?? "?");
}

const TASK = "eta";
const MAX_SUBS = 5;
const DEFAULT_THRESHOLD_MIN = 5;

interface EtaSub {
  /** 路線名（如 307）。 */
  route: string;
  city: string;
  /** 站牌關鍵字（命中 StopOfRoute 的站名）。 */
  stop: string;
  /** 方向（0/1）；未指定 = 兩個方向都監看。 */
  direction?: number;
  /** 幾分鐘內到站就推播。 */
  thresholdMin: number;
  /** 上次已推播的 key（車牌+估計分鐘），避免重複推同一班。 */
  lastKey: string;
}

interface EtaState {
  subs: EtaSub[];
}

function readSubs(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): EtaSub[] {
  const st = ctx.taskState(TASK) as Partial<EtaState> | undefined;
  return Array.isArray(st?.subs) ? (st.subs as EtaSub[]) : [];
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "3");
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 3;
}

/** 解析「訂閱」參數：路線＋城市＋站牌＋提前分鐘（純函式，測試用）。 */
export function parseSubscribe(
  rest: string,
  defaultThreshold = DEFAULT_THRESHOLD_MIN,
): {
  route: string;
  city: string;
  stop: string;
  thresholdMin: number;
} | null {
  const routeName = parseRoute(rest);
  if (!routeName) return null;
  const city = parseCity(rest);
  const stop = rest
    .replace(/請幫忙|請幫|幫忙|訂閱|動態|公車|客運|路線|的/g, " ")
    .replace(routeName, " ")
    .replace(/\b\d{1,2}\b/g, " ")
    .trim();
  if (!stop) return null;
  const nums = rest.match(/\b(\d{1,2})\b/g);
  const raw = nums && nums.length > 0 ? Number(nums[nums.length - 1]) : Number(defaultThreshold);
  const thresholdMin = Number.isInteger(raw) && raw >= 1 && raw <= 60 ? raw : defaultThreshold;
  return { route: routeName, city, stop, thresholdMin };
}

const busSkill: SkillDefinition = {
  id: "bus",
  name: "公車動態",
  description: {
    zh: "查詢公車即時動態與到站時間（需 TDX API key）。",
    en: "Real-time bus arrivals (requires TDX API key).",
    ja: "バスのリアルタイム到着（TDX API キーが必要）。",
  },
  usage: {
    zh: "公車 307 台北車站；公車 訂閱 307 台北車站 5；公車 清單；公車 取消 307",
    en: "bus 307 Taipei Main Station; bus subscribe 307 TaipeiMainStation 5; bus list; bus cancel 307",
    ja: "公車 307 台北駅; 公車 購読 307 台北駅 5; 公車 一覧; 公車 解除 307",
  },
  category: {
    zh: "交通",
    en: "Transport",
    ja: "交通",
  },
  defaultTrigger: "公車",
  triggerAliases: ["公車動態", "bus", "幾分鐘"],
  fields: [
    {
      key: "tdxClientId",
      label: { zh: "TDX Client ID", en: "TDX Client ID", ja: "TDX Client ID" },
      hint: {
        zh: "至 https://tdx.transportdata.tw 註冊取得",
        en: "Register at https://tdx.transportdata.tw",
        ja: "https://tdx.transportdata.tw で登録",
      },
    },
    {
      key: "tdxClientSecret",
      label: { zh: "TDX Client Secret", en: "TDX Client Secret", ja: "TDX Client Secret" },
      secret: true,
    },
    {
      key: "cacheTtl",
      label: { zh: "路線快取時間（TTL）", en: "Route cache TTL", ja: "路線キャッシュ TTL" },
      hint: "預設 1 天；可填 60（分鐘）、12h",
    },
    {
      key: "pollMinutes",
      label: { zh: "到站推播檢查間隔（分鐘）", en: "Arrival push interval (min)", ja: "到着通知の間隔（分）" },
      hint: "預設 3；1–60（太短會消耗 TDX 配額）",
    },
    {
      key: "thresholdMin",
      label: { zh: "預設提前幾分鐘推播", en: "Default notify lead (min)", ja: "既定の何分前に通知" },
      hint: "預設 5；可於訂閱時覆寫（公車 訂閱 307 站牌 3）",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    try {
      const res = await fetch(TDX_AUTH, { method: "GET", signal: AbortSignal.timeout(15_000) });
      return [{ name: "TDX", ok: res.status < 500, detail: `HTTP ${res.status}` }];
    } catch {
      return [{ name: "TDX", ok: false, detail: "連線失敗" }];
    }
  },
  async run(ctx: SkillContext): Promise<void> {
    const clientId = ctx.config.tdxClientId?.trim();
    const clientSecret = ctx.config.tdxClientSecret?.trim();
    if (!clientId || !clientSecret) {
      await ctx.reply("公車動態技能尚未設定 TDX API key，請到設定頁填寫 Client ID / Secret。");
      return;
    }
    const args = ctx.args.trim();
    const subs = readSubs(ctx);
    const minutes = pollMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };

    // 取消訂閱
    if (/^(取消|退訂|停止|刪除)/.test(args)) {
      if (subs.length === 0) {
        await ctx.reply("目前沒有到站推播訂閱。");
        return;
      }
      if (/全部/.test(args) && !parseRoute(args.replace(/全部/g, " "))) {
        ctx.unwatch(TASK);
        await ctx.reply(`已取消全部 ${subs.length} 個到站推播。`);
        return;
      }
      const key = args.replace(/請幫忙|請幫|幫忙|取消|退訂|停止|刪除|全部|的/g, " ").trim();
      const idx = subs.findIndex((s) => s.route === key || s.stop.includes(key) || key.includes(s.stop));
      if (idx < 0) {
        await ctx.reply(`找不到「${key}」的訂閱，請用「公車 清單」查看。`);
        return;
      }
      const removed = subs[idx];
      subs.splice(idx, 1);
      if (subs.length === 0) {
        ctx.unwatch(TASK);
        await ctx.reply(`已取消：${removed.route} ${removed.stop}（已無訂閱，停止檢查）`);
        return;
      }
      ctx.watch({ ...watchOpts, state: { subs } });
      await ctx.reply(`已取消：${removed.route} ${removed.stop}\n剩 ${subs.length} 個訂閱。`);
      return;
    }

    // 訂閱清單
    if (/^(清單|列表|list)$/.test(args)) {
      if (subs.length === 0) {
        await ctx.reply("目前沒有到站推播。用法：阿寶請幫忙 公車 訂閱 307 台北車站 5");
        return;
      }
      const lines = subs.map(
        (s) =>
          `・${s.route} ${s.stop}（${s.thresholdMin} 分內到站通知${s.direction !== undefined ? `・往方向 ${s.direction}` : ""}）`,
      );
      await ctx.reply(`到站推播（${subs.length}，${describeWatch(watchOpts)}檢查）：\n${lines.join("\n")}`);
      return;
    }

    // 訂閱到站推播
    if (/^訂閱/.test(args)) {
      const rest = args.replace(/^訂閱/g, " ");
      const parsed = parseSubscribe(rest, Number(ctx.config.thresholdMin) || DEFAULT_THRESHOLD_MIN);
      if (!parsed) {
        await ctx.reply("用法：阿寶請幫忙 公車 訂閱 307 台北車站 5（5 = 提前幾分鐘通知）");
        return;
      }
      const { route: routeName, stop, thresholdMin, city } = parsed;
      if (subs.length >= MAX_SUBS) {
        await ctx.reply(`到站推播已達上限（${MAX_SUBS} 個），請先取消舊的。`);
        return;
      }
      if (subs.some((s) => s.route === routeName && s.stop.includes(stop))) {
        await ctx.reply("已經訂閱過這班車了（可用「公車 清單」查看）。");
        return;
      }

      // 訂閱前先驗證路線與站牌存在（避免訂了寂寞）
      try {
        const token = await getToken(clientId, clientSecret);
        const found = await findRoute(routeName, token, parseTtl(ctx.config.cacheTtl, 1440), city);
        if (!found) {
          await ctx.reply(`查不到公車路線「${routeName}」，請確認路線號碼。`);
          return;
        }
        const sub: EtaSub = { route: found.route.RouteName.Zh_tw, city: found.city, stop, thresholdMin, lastKey: "" };
        subs.push(sub);
        ctx.watch({ ...watchOpts, state: { subs } });
        await ctx.reply(
          `已訂閱到站推播：${sub.route} ${stop}\n（${sub.thresholdMin} 分內到站時通知，${describeWatch(watchOpts)}檢查；「公車 取消 ${routeName}」可取消）`,
        );
      } catch (error) {
        logger.warn("公車訂閱驗證失敗", {
          route: routeName,
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.reply(`訂閱失敗：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const routeName = parseRoute(ctx.args);
    if (!routeName) {
      await ctx.reply("請指定公車路線，例如：阿寶請幫忙 公車 307 台北車站");
      return;
    }
    const preferCity = parseCity(ctx.args);
    const ttlMs = parseTtl(ctx.config.cacheTtl, 1440);

    const token = await getToken(clientId, clientSecret);
    const found = await findRoute(routeName, token, ttlMs, preferCity);
    if (!found) {
      await ctx.reply(`查不到公車路線「${routeName}」，請確認路線號碼。`);
      return;
    }
    const { city, route } = found;
    const routeKey = route.RouteName.Zh_tw;

    const [sor, eta] = await Promise.all([
      fetchJson<StopOfRoute[]>(
        `${TDX_BASE}/StopOfRoute/City/${city}/${encodeURIComponent(routeKey)}?$format=JSON`,
        token,
      ).catch(() => []),
      fetchJson<Eta[]>(
        `${TDX_BASE}/EstimatedTimeOfArrival/City/${city}/${encodeURIComponent(routeKey)}?$format=JSON`,
        token,
      ).catch(() => []),
    ]);

    const dirs = Array.isArray(sor) ? sor : [];
    const headByDir = new Map<number, string>();
    for (const d of dirs) headByDir.set(d.Direction, headsign(d, route));

    // 目標站（從原始文字找站名片段）
    const stopQuery = ctx.args
      .replace(/請幫忙|請幫|幫忙|查詢|查一下|動態|公車|客運|路線|現在|一下/g, " ")
      .replace(routeName, " ")
      .trim();

    const running = new Set((eta ?? []).map((e) => e.PlateNumb).filter(Boolean));

    if (!stopQuery) {
      const lines: string[] = [];
      for (const [dir, head] of headByDir) {
        const buses = (eta ?? []).filter((e) => e.Direction === dir && (e.EstimateTime ?? -1) >= 0);
        const nearest = buses.sort((a, b) => (a.EstimateTime ?? 0) - (b.EstimateTime ?? 0))[0];
        const minutes = nearest ? Math.max(0, Math.round((nearest.EstimateTime ?? 0) / 60)) : null;
        lines.push(
          `往 ${head}：${minutes !== null ? `最近一班約 ${minutes} 分（${nearest?.StopName?.Zh_tw ?? ""}）` : "目前無預估"}`,
        );
      }
      const op = route.Operators?.[0]?.OperatorName?.Zh_tw;
      await ctx.reply(
        `${routeKey} ${op ? `(${op})` : ""} 即時動態：\n${lines.join("\n")}\n` +
          `運行中車輛：${running.size} 輛。可加上站名查詢到站時間，例如：公車 ${routeKey} 台北車站`,
      );
      return;
    }

    const norm = (s: string) => s.trim().replace(/\s/g, "");
    const target = norm(stopQuery);
    const out: string[] = [];
    for (const d of dirs) {
      const stops = (d.Stops ?? []).slice().sort((a, b) => a.StopSequence - b.StopSequence);
      const hit = stops.find(
        (s) => norm(s.StopName?.Zh_tw ?? "").includes(target) || target.includes(norm(s.StopName?.Zh_tw ?? "")),
      );
      if (!hit) continue;
      const head = headByDir.get(d.Direction) ?? "";
      const arrivals = (eta ?? [])
        .filter((e) => e.Direction === d.Direction && e.StopUID === hit.StopUID && (e.EstimateTime ?? -1) >= 0)
        .sort((a, b) => (a.EstimateTime ?? 0) - (b.EstimateTime ?? 0))
        .slice(0, 3);
      if (arrivals.length === 0) {
        out.push(`往 ${head}（${hit.StopName?.Zh_tw}）：暫無進站預估`);
        continue;
      }
      const times = arrivals.map((e) => {
        const m = Math.max(0, Math.round((e.EstimateTime ?? 0) / 60));
        return `${m} 分${e.PlateNumb ? `（${e.PlateNumb}）` : ""}`;
      });
      out.push(`往 ${head}（${hit.StopName?.Zh_tw}）：${times.join("、")}`);
    }

    if (out.length === 0) {
      await ctx.reply(`在 ${routeKey} 路線查不到站名「${stopQuery}」，請確認站名。`);
      return;
    }
    logger.info("公車動態查詢", { city, route: routeKey, stop: stopQuery });
    await ctx.reply(`${routeKey} 到站資訊：\n${out.join("\n")}`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const subs = (Array.isArray(ctx.state?.subs) ? ctx.state.subs : []) as EtaSub[];
    if (subs.length === 0) return;

    const clientId = ctx.config.tdxClientId?.trim();
    const clientSecret = ctx.config.tdxClientSecret?.trim();
    if (!clientId || !clientSecret) {
      logger.warn("公車到站推播跳過：未設定 TDX key");
      return;
    }

    let token: string;
    try {
      token = await getToken(clientId, clientSecret);
    } catch (error) {
      logger.warn("公車到站推播跳過：TDX 認證失敗", { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const ttlMs = parseTtl(ctx.config.cacheTtl, 60);
    let changed = false;
    for (const sub of subs) {
      try {
        const found = await findRoute(sub.route, token, ttlMs, sub.city);
        if (!found) continue;
        const routeKey = found.route.RouteName.Zh_tw;
        const [sor, eta] = await Promise.all([
          fetchStopOfRoute(found.city, routeKey, token, ttlMs).catch(() => []),
          fetchJson<Eta[]>(
            `${TDX_BASE}/EstimatedTimeOfArrival/City/${found.city}/${encodeURIComponent(routeKey)}?$format=JSON`,
            token,
          ).catch(() => []),
        ]);
        const norm = (s: string) => s.trim().replace(/\s/g, "");
        const target = norm(sub.stop);
        const dirs = sub.direction !== undefined ? sor.filter((d) => d.Direction === sub.direction) : sor;

        for (const d of dirs) {
          const stops = (d.Stops ?? []).slice().sort((a, b) => a.StopSequence - b.StopSequence);
          const hit = stops.find(
            (s) => norm(s.StopName?.Zh_tw ?? "").includes(target) || target.includes(norm(s.StopName?.Zh_tw ?? "")),
          );
          if (!hit) continue;
          const nearest = (eta ?? [])
            .filter((e) => e.Direction === d.Direction && e.StopUID === hit.StopUID && (e.EstimateTime ?? -1) >= 0)
            .sort((a, b) => (a.EstimateTime ?? 0) - (b.EstimateTime ?? 0))[0];
          if (!nearest) continue;

          const minutes = Math.max(0, Math.round((nearest.EstimateTime ?? 0) / 60_000));
          if (minutes > sub.thresholdMin) continue;
          // 同一班車（車牌＋估計分鐘）只推一次，避免每次輪詢重複
          const key = `${nearest.PlateNumb ?? ""}-${minutes}`;
          if (key === sub.lastKey) continue;

          const head = headsign(d, found.route);
          sub.lastKey = key;
          changed = true;
          await ctx.reply(
            `🚌 ${routeKey} 往 ${head} 即將到站（${hit.StopName?.Zh_tw ?? sub.stop}）約 ${minutes} 分${nearest.PlateNumb ? `（${nearest.PlateNumb}）` : ""}`,
          );
          logger.info("公車到站推播", { route: routeKey, stop: hit.StopName?.Zh_tw, minutes });
        }
      } catch (error) {
        logger.warn("公車到站輪詢失敗", {
          route: sub.route,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (changed) await ctx.saveState({ subs });
  },
};

export default busSkill;
