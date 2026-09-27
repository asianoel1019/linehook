import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

const hits = new Map<string, number[]>();

setInterval(() => {
  const cutoff = Date.now() - config.rateLimit.windowMs;
  for (const [key, times] of hits) {
    const kept = times.filter((time) => time >= cutoff);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
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
