import { config } from "./config.js";

/**
 * 以設定的時區將日期格式化為帶時區偏移的 ISO 字串，例如：
 *   2026-09-27T13:05:00+08:00
 * 若時區無效則退回 UTC。
 */
export function formatInTz(date: Date, timeZone = config.timezone): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset",
    }).formatToParts(date);

    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const mo = get("month");
    const d = get("day");
    let h = get("hour");
    if (h === "24") h = "00";
    const mi = get("minute");
    const s = get("second");
    const offsetRaw = get("timeZoneName"); // e.g. GMT+08:00 or GMT
    const offset = offsetRaw === "GMT" ? "+00:00" : offsetRaw.replace("GMT", "");

    return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
  } catch {
    return date.toISOString();
  }
}

/** 目前時間（依設定時區）帶偏移的 ISO 字串。 */
export function nowIso(): string {
  return formatInTz(new Date());
}

/** 驗證 IANA 時區是否有效。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 依時區取得當地日期（用於技能查詢日期）。 */
export function nowInTz(timeZone = config.timezone): Date {
  // 回傳一個 Date，其「當地欄位」等於該時區的現在時間，方便抓 y/m/d/h/m。
  // 注意：它的 getTime() 是平移後的假 epoch，只能取欄位，不可直接當時間戳比較。
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour") === 24 ? 0 : get("hour");
  return new Date(y, mo - 1, d, h, get("minute"), get("second"));
}

/** 目標時區在某毫秒時刻的 UTC 偏移（毫秒）。 */
export function tzOffsetMs(timeZone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second")) - ms;
}

/** 把「目標時區牆鐘時間」轉成真實 epoch 毫秒（兩次逼近，日光節約邊界更準）。 */
export function zonedTimeToMs(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone = config.timezone,
): number {
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  try {
    const first = asUTC - tzOffsetMs(timeZone, asUTC);
    return asUTC - tzOffsetMs(timeZone, first);
  } catch {
    return asUTC;
  }
}

/** 解析「YYYY-MM-DD HH:mm[:ss]」為目標時區的 epoch 毫秒；失敗回 null。 */
export function parseDateTimeInTz(text: string, timeZone = config.timezone): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
  if (!m) return null;
  return zonedTimeToMs(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] ?? "0"),
    },
    timeZone,
  );
}
