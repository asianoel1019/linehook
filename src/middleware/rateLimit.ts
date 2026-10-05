import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

const hits = new Map<string, number[]>();
const loginHits = new Map<string, number[]>();

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX = 20;
/** 同一帳號連續失敗節流（B6）：10 分鐘內失敗達上限即暫時拒絕。 */
const LOGIN_USER_FAILS = 10;
const LOGIN_USER_WINDOW_MS = 10 * 60 * 1000;
const userFails = new Map<string, number[]>();

setInterval(() => {
  const cutoff = Date.now() - config.rateLimit.windowMs;
  for (const [key, times] of hits) {
    const kept = times.filter((time) => time >= cutoff);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
  }
  // loginHits 原本無 GC（B6），一併清理避免無限成長。
  const loginCutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [key, times] of loginHits) {
    const kept = times.filter((time) => time >= loginCutoff);
    if (kept.length === 0) loginHits.delete(key);
    else loginHits.set(key, kept);
  }
  const userCutoff = Date.now() - LOGIN_USER_WINDOW_MS;
  for (const [key, times] of userFails) {
    const kept = times.filter((time) => time >= userCutoff);
    if (kept.length === 0) userFails.delete(key);
    else userFails.set(key, kept);
  }
}, 60_000).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const times = (hits.get(key) ?? []).filter(
    (time) => now - time < config.rateLimit.windowMs,
  );

  if (times.length >= config.rateLimit.max) {
    logger.warn("請求超過速率限制", { ip: key });
    res.status(429).json({ ok: false, error: "請求過於頻繁" });
    return;
  }

  times.push(now);
  hits.set(key, times);
  next();
}

/** 登入專用嚴格限流：每 IP 每 5 分鐘最多 20 次，避免暴力破解。 */
export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const times = (loginHits.get(key) ?? []).filter((time) => now - time < LOGIN_WINDOW_MS);

  if (times.length >= LOGIN_MAX) {
    logger.warn("登入嘗試過於頻繁", { ip: key });
    res.status(429).json({ ok: false, error: "登入嘗試過於頻繁，請稍後再試" });
    return;
  }

  times.push(now);
  loginHits.set(key, times);
  next();
}

/** 記錄某帳號一次登入失敗；短時間累積過多即回傳 true（呼叫端應拒絕）。 */
export function recordLoginFailure(user: string): boolean {
  const key = user.trim() || "(empty)";
  const now = Date.now();
  const times = (userFails.get(key) ?? []).filter((time) => now - time < LOGIN_USER_WINDOW_MS);
  times.push(now);
  userFails.set(key, times);
  return times.length >= LOGIN_USER_FAILS;
}

/** 登入成功時清除該帳號的失敗計數。 */
export function clearLoginFailures(user: string): void {
  userFails.delete(user.trim() || "(empty)");
}
