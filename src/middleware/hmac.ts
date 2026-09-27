import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

export type RawBodyRequest = Request & { rawBody?: Buffer };

const seenNonces = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - config.hmacMaxSkewSec * 1000;
  for (const [nonce, time] of seenNonces) {
    if (time < cutoff) seenNonces.delete(nonce);
  }
}, 60_000).unref();

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

function verifySignature(req: Request): { ok: boolean; reason?: string } {
  const signature = String(req.header("x-signature") ?? "");
  const timestamp = String(req.header("x-timestamp") ?? "");
  const nonce = String(req.header("x-nonce") ?? "");

  if (!timestamp) return { ok: false, reason: "缺少 X-Timestamp" };

  const parsed = Number(timestamp);
  const skewSec = Math.abs(Date.now() - parsed) / 1000;
  if (!Number.isFinite(parsed) || skewSec > config.hmacMaxSkewSec) {
    return { ok: false, reason: "時間戳記無效或已過期" };
  }

  if (nonce) {
    if (seenNonces.has(nonce)) return { ok: false, reason: "重複的 nonce" };
    seenNonces.set(nonce, Date.now());
  }

  const raw = (req as RawBodyRequest).rawBody ?? Buffer.from("");
  const expected = crypto
    .createHmac("sha256", config.hmacSecret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");

  if (!safeEqual(signature, expected)) return { ok: false, reason: "簽章驗證失敗" };
  return { ok: true };
}

function requestToken(req: Request): string {
  const query = req.query.token;
  if (typeof query === "string") return query;
  return String(req.header("x-webhook-token") ?? "");
}

function bearerToken(req: Request): string {
  const header = String(req.header("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function validApiToken(req: Request): boolean {
  const provided = bearerToken(req);
  if (!provided) return false;
  const candidates = [config.apiToken, ...config.apiTokens.map((item) => item.token)].filter(
    Boolean,
  );
  return candidates.some((token) => safeEqual(provided, token));
}

/**
 * Webhook 驗證：HMAC 簽章、URL token、API Token（Bearer）可並存（任一通過即可）。
 * 三者皆未設定時不驗證。
 */
export function verifyWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const hasHmac = Boolean(config.hmacSecret);
  const hasToken = Boolean(config.webhookToken);
  const hasApi = Boolean(config.apiToken) || config.apiTokens.some((item) => item.token);

  if (!hasHmac && !hasToken && !hasApi) {
    next();
    return;
  }

  if (hasHmac) {
    const result = verifySignature(req);
    if (result.ok) {
      next();
      return;
    }
    if (!hasToken && !hasApi) {
      logger.warn("webhook 簽章驗證失敗", { ip: req.ip, reason: result.reason });
      res.status(403).json({ ok: false, error: result.reason ?? "驗證失敗" });
      return;
    }
  }

  if (hasToken && safeEqual(requestToken(req), config.webhookToken)) {
    next();
    return;
  }

  if (hasApi && validApiToken(req)) {
    next();
    return;
  }

  logger.warn("webhook 驗證失敗", { ip: req.ip });
  res.status(403).json({ ok: false, error: "驗證失敗" });
}

const seenIdempotency = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, time] of seenIdempotency) {
    if (time < cutoff) seenIdempotency.delete(key);
  }
}, 60_000).unref();

export function isDuplicateIdempotency(key: string): boolean {
  return seenIdempotency.has(key);
}

export function markIdempotency(key: string): void {
  seenIdempotency.set(key, Date.now());
}
