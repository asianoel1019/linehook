import { parseCron } from "../line/cron.js";
import type { WatchOptions } from "./types.js";

/** 把 watch 選項轉成標準 5 欄 cron；無效直接 throw。 */
export function watchOptionsToCron(opts: WatchOptions): string {
  if (!opts || typeof opts.task !== "string" || !opts.task.trim()) {
    throw new Error("watch 需要任務名稱（task）");
  }
  const sources = [opts.cron ? 1 : 0, opts.everyMinutes !== undefined ? 1 : 0, opts.at ? 1 : 0].reduce(
    (a, b) => a + b,
    0,
  );
  if (sources > 1) throw new Error("cron、everyMinutes、at 只能擇一指定");

  if (opts.cron !== undefined) {
    const cron = opts.cron.trim();
    parseCron(cron); // 驗證格式
    return cron;
  }
  if (opts.at !== undefined) return dailyAtToCron(opts.at);
  if (opts.everyMinutes !== undefined) return everyMinutesToCron(opts.everyMinutes);
  return "*/30 * * * *";
}

/** 每 N 分鐘轉 cron。N 為 1–1440；>60 需為 60 的倍數。 */
export function everyMinutesToCron(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("everyMinutes 需為 1–1440 的整數");
  }
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes % 60 !== 0) throw new Error("超過 60 分鐘的間隔需為 60 的倍數（或改用 cron）");
  if (minutes === 1440) return "0 0 * * *";
  return `0 */${minutes / 60} * * *`;
}

/** 每日 "HH:mm" 轉 cron。 */
export function dailyAtToCron(at: string): string {
  const m = /^\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*$/.exec(at ?? "");
  if (!m) throw new Error("時間格式錯誤，請用 HH:mm（例如 08:00）");
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

/** 人類可讀的任務週期描述（回覆確認訊息用）。 */
export function describeWatch(opts: WatchOptions): string {
  if (opts.cron) return `cron ${opts.cron.trim()}`;
  if (opts.at) return `每天 ${opts.at.trim()}`;
  if (opts.everyMinutes !== undefined) {
    const n = opts.everyMinutes;
    if (n >= 60 && n % 60 === 0) return n === 1440 ? "每天" : `每 ${n / 60} 小時`;
    return `每 ${n} 分鐘`;
  }
  return "每 30 分鐘";
}
