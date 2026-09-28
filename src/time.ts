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
