import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, type ApiScope } from "../config.js";
import { logger } from "../logger.js";
import { recordTokenUsage } from "../token-stats.js";
import { recordMetric } from "../metrics.js";
import { sessionValid } from "./session.js";
import { safeEqual } from "../safe-equal.js";

export type RawBodyRequest = Request & { rawBody?: Buffer };

const seenNonces = new Map<string, number>();
const MAX_NONCES = 5000;

function rememberNonce(nonce: string): void {
  seenNonces.set(nonce, Date.now());
  if (seenNonces.size > MAX_NONCES) {
    const oldest = seenNonces.keys().next();
    if (!oldest.done) seenNonces.delete(oldest.value);
  }
}

setInterval(() => {
  const cutoff = Date.now() - config.hmacMaxSkewSec * 1000;
  for (const [nonce, time] of seenNonces) {
    if (time < cutoff) seenNonces.delete(nonce);
  }
}, 60_000).unref();

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

  if (nonce && seenNonces.has(nonce)) return { ok: false, reason: "重複的 nonce" };

  const raw = (req as RawBodyRequest).rawBody ?? Buffer.from("");
  const expected = crypto
    .createHmac("sha256", config.hmacSecret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");

  if (!safeEqual(signature, expected)) return { ok: false, reason: "簽章驗證失敗" };
  // 簽章通過後才記錄 nonce，避免攻擊者用無效簽章燒掉合法 nonce。
  if (nonce) rememberNonce(nonce);
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

export interface ApiAuth {
  name: string;
  scopes: ApiScope[];
}

/** 正規化 scope：缺失/格式錯誤沿用舊行為（僅發送）；明確空陣列 = 無任何權限。 */
export function normalizeScopes(scopes: unknown): ApiScope[] {
  if (!Array.isArray(scopes)) return ["send"];
  return scopes.filter((s): s is ApiScope => s === "read" || s === "send" || s === "admin");
}

/** admin 隱含所有權限。 */
export function tokenHasScope(auth: ApiAuth, ...required: ApiScope[]): boolean {
  if (auth.scopes.includes("admin")) return true;
  return required.some((s) => auth.scopes.includes(s));
}

export function findApiToken(req: Request): ApiAuth | null {
  const provided = bearerToken(req);
  if (!provided) return null;
  if (config.apiToken && safeEqual(provided, config.apiToken)) {
    return { name: "", scopes: ["send"] };
  }
  for (const item of config.apiTokens) {
    if (item.token && safeEqual(provided, item.token)) {
      return { name: item.name || "", scopes: normalizeScopes(item.scopes) };
    }
  }
  return null;
}

/**
 * session 登入視為完整權限；否則檢查 Bearer token 是否具備任一所需 scope。
 * 無 Authorization 標頭時沿用原本 requireSession 的行為（GET 導向登入頁，其餘 401），
 * 避免破壞瀏覽器流程。
 */
export function requireSessionOrApi(...scopes: ApiScope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (sessionValid(req, false)) {
      next();
      return;
    }
    const auth = findApiToken(req);
    if (auth && tokenHasScope(auth, ...scopes)) {
      recordTokenUsage(auth.name || "(主 Token)", req.ip ?? "");
      (req as RawBodyRequest & { apiAuth?: ApiAuth }).apiAuth = auth;
      next();
      return;
    }
    if (req.header("authorization")) {
      res.status(401).json({ ok: false, error: "需要登入" });
      return;
    }
    if (req.method !== "GET" || req.path.endsWith(".json")) {
      res.status(401).json({ ok: false, error: "需要登入" });
      return;
    }
    res.redirect("/login");
  };
}

/**
 * 是否有任一 webhook 驗證生效（B1）。
 * 三者全關或皆未設定時，發送端點形同公開——開機應直接拒絕啟動。
 */
export function webhookAuthEnabled(): boolean {
  return Boolean(
    (config.hmacEnabled && config.hmacSecret)
    || (config.webhookTokenEnabled && config.webhookToken)
    || (config.apiTokenEnabled && (config.apiToken || config.apiTokens.some((item) => item.token))),
  );
}

/** 設定頁安全燈號：red（無驗證）/ yellow（僅 URL Token，易留存於 log）/ green。 */
export function webhookAuthLevel(): "red" | "yellow" | "green" {
  const hasHmac = Boolean(config.hmacEnabled && config.hmacSecret);
  const hasApi = Boolean(config.apiTokenEnabled && (config.apiToken || config.apiTokens.some((item) => item.token)));
  const hasToken = Boolean(config.webhookTokenEnabled && config.webhookToken);
  if (hasHmac || hasApi) return "green";
  if (hasToken) return "yellow";
  return "red";
}

/**
 * Webhook 驗證：HMAC 簽章、URL token、API Token（Bearer）可並存（任一通過即可）。
 * 每種方式各有獨立開關；開關全關或三者皆未設定時不驗證。
 */
export function verifyWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const hasHmac = config.hmacEnabled && Boolean(config.hmacSecret);
  const hasToken = config.webhookTokenEnabled && Boolean(config.webhookToken);
  const hasApi = config.apiTokenEnabled && (Boolean(config.apiToken) || config.apiTokens.some((item) => item.token));

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
      recordMetric("webhook_auth_failures_total", 1, { method: "hmac", reason: result.reason ?? "unknown" });
      res.status(403).json({ ok: false, error: result.reason ?? "驗證失敗" });
      return;
    }
  }

  if (hasToken && safeEqual(requestToken(req), config.webhookToken)) {
    next();
    return;
  }

  if (hasApi) {
    const auth = findApiToken(req);
    if (auth) {
      if (!tokenHasScope(auth, "send")) {
        logger.warn("API Token 權限不足（需 send）", { ip: req.ip, name: auth.name });
        recordMetric("webhook_auth_failures_total", 1, { method: "api", reason: "scope" });
        res.status(403).json({ ok: false, error: "權限不足（需要 send）" });
        return;
      }
      recordTokenUsage(auth.name || "(主 Token)", req.ip ?? "");
      next();
      return;
    }
  }

  logger.warn("webhook 驗證失敗", { ip: req.ip });
  recordMetric("webhook_auth_failures_total", 1, { method: "none", reason: "auth" });
  res.status(403).json({ ok: false, error: "驗證失敗" });
}

const seenIdempotency = new Map<string, number>();
const MAX_IDEMPOTENCY_KEYS = 5000;
const MAX_IDEMPOTENCY_KEY_LEN = 256;

function idempotencyWindowMs(): number {
  return config.idempotencyWindowMs > 0 ? config.idempotencyWindowMs : 10 * 60 * 1000;
}

setInterval(() => {
  const cutoff = Date.now() - idempotencyWindowMs();
  for (const [key, time] of seenIdempotency) {
    if (time < cutoff) seenIdempotency.delete(key);
  }
}, 60_000).unref();

export function isDuplicateIdempotency(key: string): boolean {
  if (key.length > MAX_IDEMPOTENCY_KEY_LEN) return false;
  const time = seenIdempotency.get(key);
  if (time === undefined) return false;
  if (Date.now() - time > idempotencyWindowMs()) {
    seenIdempotency.delete(key);
    return false;
  }
  return true;
}

/**
 * 先佔位再送：檢查即寫入，避免同視窗併發雙送。
 * 已存在回傳 false；否則寫入並回傳 true。
 */
export function reserveIdempotency(key: string): boolean {
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LEN) return true;
  if (isDuplicateIdempotency(key)) return false;
  seenIdempotency.set(key, Date.now());
  if (seenIdempotency.size > MAX_IDEMPOTENCY_KEYS) {
    const oldest = seenIdempotency.keys().next();
    if (!oldest.done) seenIdempotency.delete(oldest.value);
  }
  return true;
}

/** 佔位後若最終失敗，釋放 key 讓合法重試可再送。 */
export function releaseIdempotency(key: string): void {
  seenIdempotency.delete(key);
}

export function markIdempotency(key: string): void {
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LEN) return;
  seenIdempotency.set(key, Date.now());
  if (seenIdempotency.size > MAX_IDEMPOTENCY_KEYS) {
    const oldest = seenIdempotency.keys().next();
    if (!oldest.done) seenIdempotency.delete(oldest.value);
  }
}
