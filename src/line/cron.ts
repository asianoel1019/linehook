export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(
  expr: string,
  min: number,
  max: number,
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const raw of expr.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "*") continue;
    restricted = true;

    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`無效的 cron 間隔：${part}`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = b === undefined ? (stepPart ? max : Number(a)) : Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`無效的 cron 欄位：${part}`);
      }
      // 明確寫出的單一數值若超出範圍，直接報錯而不是靜默變成 *。
      if (b === undefined && !stepPart && (start < min || start > max)) {
        throw new Error(`無效的 cron 欄位：${part}（範圍 ${min}-${max}）`);
      }
    }
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.add(value);
    }
  }

  if (values.size === 0) {
    if (restricted) throw new Error(`無效的 cron 欄位（範圍內無有效值）`);
    for (let value = min; value <= max; value++) values.add(value);
    restricted = false;
  }
  return { values, restricted };
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron 需為 5 欄：分 時 日 月 週（例如 0 9 * * 1-5）");
  }
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const days = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const weekdaysRaw = parseField(parts[4], 0, 7);
  const weekdays = new Set<number>();
  for (const value of weekdaysRaw.values) weekdays.add(value === 7 ? 0 : value);

  return {
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    months: months.values,
    weekdays,
    domRestricted: days.restricted,
    dowRestricted: weekdaysRaw.restricted,
  };
}

/** 由 from（毫秒）之後找出下一個符合 cron 的時間（毫秒）；一年內找不到回 null。 */
export function nextRun(cron: CronFields, from: number, timeZone?: string): number | null {
  // 以目標時區的牆鐘時間比對：把 from 平移到「伺服器本地牆鐘＝目標時區牆鐘」的代理時間，
  // 用原本的高效逐分鐘演算法，最後再平移回真實 epoch。日光節約邊界以結果點重算一次。
  let shift = 0;
  let useTz = false;
  if (timeZone) {
    try {
      shift = tzOffsetMs(timeZone, from) - serverOffsetMs(from);
      useTz = true;
    } catch {
      shift = 0;
      useTz = false;
    }
  }
  const date = new Date(from + shift);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  const limit = new Date(from + shift);
  limit.setFullYear(limit.getFullYear() + 1);

  const toEpoch = (proxyMs: number): number => {
    if (!useTz || !timeZone) return proxyMs;
    try {
      return proxyMs - (tzOffsetMs(timeZone, proxyMs) - serverOffsetMs(proxyMs));
    } catch {
      return proxyMs - shift;
    }
  };

  while (date.getTime() <= limit.getTime()) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekday = date.getDay();
    const dayOfMonthMatch = cron.days.has(day);
    const dayOfWeekMatch = cron.weekdays.has(weekday);

    let dayOk: boolean;
    if (cron.domRestricted && cron.dowRestricted) dayOk = dayOfMonthMatch || dayOfWeekMatch;
    else if (cron.domRestricted) dayOk = dayOfMonthMatch;
    else if (cron.dowRestricted) dayOk = dayOfWeekMatch;
    else dayOk = true;

    if (
      cron.months.has(month) &&
      dayOk &&
      cron.hours.has(date.getHours()) &&
      cron.minutes.has(date.getMinutes())
    ) {
      return toEpoch(date.getTime());
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}

function serverOffsetMs(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}

function tzOffsetMs(timeZone: string, ms: number): number {
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
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - ms;
}
