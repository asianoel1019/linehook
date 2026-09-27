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
    }
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.add(value);
    }
  }

  if (values.size === 0) {
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
export function nextRun(cron: CronFields, from: number): number | null {
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + 1);

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
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}
