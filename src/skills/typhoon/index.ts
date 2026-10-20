import { config } from "@lw/config";
import { logger } from "@lw/logger";
import { parseTtl, readCache, writeCache } from "@lw/skills/cache";
import { fetchJson as netFetchJson } from "@lw/net";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "@lw/skills/types";
import { describeWatch } from "@lw/skills/watch";

const UA = "Mozilla/5.0 (compatible; ImHook/1.0)";
const WARN_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-005";
const TY_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005";
const TASK = "watch";

/** CWA phenomena 代碼 → 中文名稱（對照不到用原值）。 */
const PHENOMENA_ZH: Record<string, string> = {
  RAIN: "大雨",
  HEAVY_RAIN: "豪雨",
  TDP: "熱帶性低氣壓",
  TS: "颱風",
  WIND: "強風",
  LOWT: "低溫",
  HIGHT: "高溫",
  FOG: "濃霧",
  DENSEFOG: "濃霧",
  THUNDER: "雷雨",
  WAVE: "長浪",
  VIOLENT_WIND: "強風",
  HEAT: "高溫",
  COLD: "寒流",
};

export interface WarningItem {
  /** 警特報名稱，例如「豪雨特報」。 */
  title: string;
  /** 現象代碼（RAIN/WIND/…）。 */
  phenomena: string;
  /** 特報／注意等層級。 */
  significance: string;
  startTime: string;
  endTime: string;
  /** 影響縣市（去重後）。 */
  areas: string[];
}

export interface TyphoonInfo {
  name: string;
  no: string;
  /** 最新定位置時間（ISO）。 */
  fixTime: string;
  lat?: number;
  lon?: number;
  /** 移動速度 km/h。 */
  speed?: number;
  /** 移動方向（度，0 = 北）。 */
  direction?: number;
  /** 近中心最大風速 m/s（有填才顯示）。 */
  maxWind?: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function significanceZh(s: string): string {
  const v = s.toUpperCase();
  if (v === "WARNING") return "特報";
  if (v === "WATCH") return "注意";
  if (v === "ALERT") return "警戒";
  return v ? s : "特報";
}

function phenomenaZh(code: string): string {
  return PHENOMENA_ZH[code.toUpperCase()] ?? code;
}

/** 安全讀取巢狀物件值（路徑不存在回 undefined）。 */
function dig(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * 解析 W-C0033-005（天氣警特報）。
 * 結構可能為 records.location[]（每縣市一筆，hazardConditions.hazards[]）或
 * records.hazards[]；兩種都吃，其餘回空陣列（Defensive parsing）。
 */
export function parseWarnings(data: unknown): WarningItem[] {
  const out: WarningItem[] = [];
  const seen = new Set<string>();

  const push = (hazard: unknown, areasText: string[]): void => {
    const info = dig(hazard, ["hazard", "info"]) ?? hazard;
    if (!info || typeof info !== "object") return;
    const phenomena = str((info as Record<string, unknown>).phenomena);
    const significance = str((info as Record<string, unknown>).significance);
    if (!phenomena) return;
    const title = `${phenomenaZh(phenomena)}${significanceZh(significance)}`;
    const startTime = str((info as Record<string, unknown>).startTime);
    const endTime = str((info as Record<string, unknown>).endTime);
    const areas = areasText.length > 0 ? [...new Set(areasText)] : [];
    const key = `${title}｜${areas.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, phenomena, significance, startTime, endTime, areas });
  };

  // 形狀 A：records.location[].hazardConditions.hazards[]
  const locations = dig(data, ["records", "location"]);
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      const area = str((loc as Record<string, unknown>)?.locationName);
      const hazards = dig(loc, ["hazardConditions", "hazards"]);
      if (Array.isArray(hazards)) for (const h of hazards) push(h, area ? [area] : []);
    }
    if (out.length > 0) return out;
  }

  // 形狀 B：records.hazards[]（hazard.info 自帶 affectedAreas）
  const hazardsB = dig(data, ["records", "hazards"]);
  if (Array.isArray(hazardsB)) {
    for (const h of hazardsB) {
      const info = dig(h, ["hazard", "info"]) ?? h;
      const areasRaw = dig(info, ["affectedAreas", "area"]);
      const areaNames = Array.isArray(areasRaw)
        ? areasRaw
            .map((a: unknown) => str(dig(a, ["description"])) || str((a as Record<string, unknown>)?.areaDesc))
            .filter(Boolean)
        : [];
      push(h, areaNames);
    }
  }
  return out;
}

/** 解析 W-C0034-005（颱風）的 records.TyphoonList[]；取每颱風最新定位。 */
export function parseTyphoon(data: unknown): TyphoonInfo[] {
  const list = dig(data, ["records", "TyphoonList"]);
  if (!Array.isArray(list)) return [];
  const out: TyphoonInfo[] = [];
  for (const t of list) {
    const rec = (t ?? {}) as Record<string, unknown>;
    const name = str(rec.TyphoonName) || str(rec.TyphoonNo) || str(rec.cwaTyNo);
    if (!name) continue;
    const paths = Array.isArray(rec.PathData) ? rec.PathData : [];
    const latest = (paths as Array<Record<string, unknown>>).at(-1) ?? {};
    out.push({
      name,
      no: str(rec.CwaTyNo) || str(rec.cwaTyNo) || str(rec.TyphoonNo),
      fixTime: str(latest.Time) || str(rec.AnalysisTime),
      lat: num(latest.Lat),
      lon: num(latest.Lon),
      speed: num(latest.MovingSpeed),
      direction: num(latest.MovingDirection),
      maxWind: num(latest.MaxWindSpeed),
    });
  }
  return out;
}

function fmtLatLon(lat?: number, lon?: number): string {
  if (lat === undefined || lon === undefined) return "";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

function fmtTime(iso: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/.exec(iso ?? "");
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}` : (iso ?? "").slice(0, 16);
}

function directionText(deg?: number): string {
  if (deg === undefined) return "";
  const dirs = [
    "北",
    "北北東",
    "東北",
    "東北東",
    "東",
    "東南東",
    "東南",
    "南南東",
    "南",
    "南南西",
    "西南",
    "西南西",
    "西",
    "西北西",
    "西北",
    "北北西",
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return `，向${dirs[idx]}`;
}

/** 警特報＋颱風的變更簽章（不含時間欄位，避免延長時重複推播）。 */
export function alertSignature(warnings: WarningItem[], typhoons: TyphoonInfo[]): string {
  const w = warnings
    .map((x) => `${x.title}｜${x.areas.join(",")}`)
    .sort()
    .join(";");
  const t = typhoons
    .map((x) => `${x.name}#${x.no}`)
    .sort()
    .join(";");
  return `${w}##${t}`;
}

export function formatWarnings(warnings: WarningItem[], typhoons: TyphoonInfo[]): string {
  if (warnings.length === 0 && typhoons.length === 0) {
    return "✅ 目前無生效的天氣警特報或颱風警報。";
  }
  const lines: string[] = [];
  if (warnings.length > 0) {
    lines.push(`⚠️ 目前警特報 ${warnings.length} 筆：`);
    for (const w of warnings) {
      const areas = w.areas.length > 0 ? `（${w.areas.slice(0, 8).join("、")}${w.areas.length > 8 ? " 等" : ""}）` : "";
      const until = w.endTime ? ` 至 ${fmtTime(w.endTime)}` : "";
      lines.push(`・${w.title}${areas}${until}`);
    }
  }
  for (const t of typhoons) {
    const pos = fmtLatLon(t.lat, t.lon);
    const speed = t.speed !== undefined ? `，時速 ${t.speed} km${directionText(t.direction)}` : "";
    const wind = t.maxWind !== undefined ? `，近中心最大風速 ${t.maxWind} m/s` : "";
    lines.push(
      `🌀 颱風「${t.name}」${t.fixTime ? `（${fmtTime(t.fixTime)} 定位）` : ""}${pos ? `位於 ${pos}` : ""}${speed}${wind}`,
    );
  }
  lines.push("停班停課依人事行政總處公告（可用「放假 明天」查詢）。");
  return lines.join("\n");
}

interface RawResponse {
  records?: unknown;
  error?: string;
}

async function cwaFetch(url: string, key: string): Promise<unknown> {
  const full = `${url}?Authorization=${encodeURIComponent(key)}&format=JSON`;
  return netFetchJson<RawResponse>(
    full,
    { headers: { "User-Agent": UA, Accept: "application/json" } },
    { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 },
  );
}

function pollMinutesOf(config: Record<string, string>): number {
  const n = Number(config.pollMinutes ?? "30");
  return Number.isInteger(n) && n >= 10 && n <= 1440 ? n : 30;
}

/** 讀取 CWA key：本技能設定，缺則沿用天氣技能已填好的 key（不要求重填）。 */
function cwaKeyOf(skillConfig: Record<string, string>): string {
  const own = (skillConfig.cwaKey ?? "").trim();
  if (own) return own;
  return (config.skills.find((s) => s.id === "weather")?.config?.cwaKey ?? "").trim();
}

const typhoonSkill: SkillDefinition = {
  id: "typhoon",
  name: "颱風 / 警特報",
  description: {
    zh: "查詢天氣警特報與颱風動態（CWA）；可訂閱自動推播。",
    en: "Check CWA weather warnings and typhoon updates; subscribe for auto alerts.",
    ja: "気象警特報と台風情報を確認（CWA）。購読で自動通知。",
  },
  usage: {
    zh: "颱風；颱風 訂閱 30；颱風 清單；颱風 取消",
    en: "typhoon; typhoon subscribe 30; typhoon list; typhoon cancel",
    ja: "台風；台風 購読 30；台風 一覧；台風 解除",
  },
  category: { zh: "生活資訊", en: "Life", ja: "生活" },
  defaultTrigger: "颱風",
  naturalKeywords: ["颱風動態", "颱風在哪", "颱風假"],
  triggerAliases: ["警報", "颱風預報", "警特報", "熱帶性低氣壓", "typhoon"],
  fields: [
    {
      key: "cwaKey",
      label: { zh: "CWA API Key", en: "CWA API Key", ja: "CWA API キー" },
      secret: true,
      hint: {
        zh: "至 opendata.cwa.gov.tw 免費申請；留空則沿用天氣技能的 key",
        en: "Free sign-up at opendata.cwa.gov.tw; blank reuses the weather skill key",
        ja: "opendata.cwa.gov.tw で無料登録。空白なら天気スキルの key を流用",
      },
    },
    {
      key: "pollMinutes",
      label: { zh: "推播檢查間隔（分鐘）", en: "Poll interval (min)", ja: "通知チェック間隔（分）" },
      hint: "預設 30；10–1440（間隔太短會消耗 CWA 配額）",
    },
    {
      key: "cacheTtl",
      label: { zh: "手動查詢快取（分鐘）", en: "Manual query cache (min)", ja: "手動クエリのキャッシュ（分）" },
      hint: "預設 10 分鐘；避免重複查詢耗配額",
    },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "CWA 開放資料", ok: true, detail: "使用 W-C0033-005 / W-C0034-005" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const args = ctx.args.replace(/請幫忙|請幫|幫忙|的/g, " ").trim();
    const minutes = pollMinutesOf(ctx.config);
    const watchOpts = { task: TASK, everyMinutes: minutes };

    // 取消訂閱
    if (/^(取消|退訂|停止|close)/.test(args)) {
      const ok = ctx.unwatch(TASK);
      await ctx.reply(ok ? `已停止颱風/警特報推播（${describeWatch(watchOpts)}檢查）。` : "目前沒有訂閱中的推播。");
      return;
    }

    // 訂閱
    const sub = /^(訂閱|subscribe)\s*(\d{1,4})?/.exec(args);
    if (sub) {
      const n = sub[2] ? Number(sub[2]) : minutes;
      if (!Number.isInteger(n) || n < 10 || n > 1440) {
        await ctx.reply("訂閱間隔需為 10–1440 分鐘，例如：颱風 訂閱 30");
        return;
      }
      const key = cwaKeyOf(ctx.config);
      if (!key) {
        await ctx.reply("訂閱推播需要 CWA API Key：請至 opendata.cwa.gov.tw 免費申請，並填入本技能或天氣技能的設定。");
        return;
      }
      ctx.watch({ ...watchOpts, everyMinutes: n, state: { sig: "" } });
      await ctx.reply(
        `已訂閱颱風/警特報推播，${describeWatch({ task: TASK, everyMinutes: n })}檢查，有新警報或解除時通知你。`,
      );
      return;
    }

    // 清單
    if (/^(清單|列表|list)$/.test(args)) {
      const watches = ctx.watches();
      if (watches.length === 0) {
        await ctx.reply("目前沒有推播訂閱。用法：颱風 訂閱 30（每 30 分鐘檢查）");
        return;
      }
      const lines = watches.map((w) => `・${w.task}｜${w.cron}｜下次 ${fmtTime(w.runAt)}`);
      await ctx.reply(`推播訂閱（${watches.length}）：\n${lines.join("\n")}`);
      return;
    }

    // 手動查詢目前警特報與颱風動態
    const key = cwaKeyOf(ctx.config);
    if (!key) {
      await ctx.reply(
        "尚未設定 CWA API Key。\n請至 opendata.cwa.gov.tw 免費申請，填入本技能（或天氣技能）的「CWA API Key」。",
      );
      return;
    }

    let warnings: WarningItem[] = [];
    let typhoons: TyphoonInfo[] = [];
    const ttlMs = parseTtl(ctx.config.cacheTtl, 10);
    const warnHit = readCache<WarningItem[]>("typhoon-warnings", ttlMs);
    const tyHit = readCache<TyphoonInfo[]>("typhoon-list", ttlMs);
    try {
      if (warnHit) warnings = warnHit;
      else {
        warnings = parseWarnings(await cwaFetch(WARN_API, key));
        writeCache("typhoon-warnings", warnings);
      }
      if (tyHit) typhoons = tyHit;
      else {
        typhoons = parseTyphoon(await cwaFetch(TY_API, key));
        writeCache("typhoon-list", typhoons);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("CWA 警特報/颱風查詢失敗", { error: message });
      if (/401|403|Unauthor/i.test(message)) {
        await ctx.reply("CWA API Key 無效或過期，請至技能設定更新（opendata.cwa.gov.tw）。");
        return;
      }
      await ctx.reply("氣象署開放資料暫時無法連線，請稍後再試。");
      return;
    }

    await ctx.reply(formatWarnings(warnings, typhoons));
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const prevSig = typeof ctx.state?.sig === "string" ? (ctx.state.sig as string) : "";

    const key = cwaKeyOf(ctx.config);
    if (!key) {
      logger.warn("颱風推播跳過：未設定 CWA Key");
      return;
    }

    let warnings: WarningItem[];
    let typhoons: TyphoonInfo[];
    try {
      warnings = parseWarnings(await cwaFetch(WARN_API, key));
      typhoons = parseTyphoon(await cwaFetch(TY_API, key));
    } catch (error) {
      // 保留舊狀態，下輪再試；避免網路抖動誤推「解除」。
      logger.warn("颱風輪詢失敗，保留舊狀態", { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const sig = alertSignature(warnings, typhoons);
    if (sig === prevSig) return;

    const prevActive = prevSig !== "" && prevSig !== "##";
    const nextActive = sig !== "" && sig !== "##";
    if (prevActive && !nextActive) {
      await ctx.reply("✅ 天氣警特報／颱風已全部解除。");
    } else {
      // 開始生效或內容變動（個別警報新增/結束）：推一次最新快照。
      await ctx.reply(formatWarnings(warnings, typhoons));
    }
    await ctx.saveState({ sig });
  },
};

export default typhoonSkill;
