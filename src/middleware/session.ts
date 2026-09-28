import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

const SESSION_TTL_MS = 5 * 60 * 1000;
const COOKIE_NAME = "lw_sid";
const sessions = new Map<string, number>();

interface AuthOverride {
  user: string;
  salt: string;
  hash: string;
}

let override: AuthOverride | null = null;

function hashPassword(pass: string, salt: string): string {
  return crypto.scryptSync(pass, salt, 64).toString("hex");
}

function loadOverride(): void {
  if (!existsSync(config.authPath)) return;
  try {
    const data = JSON.parse(readFileSync(config.authPath, "utf8")) as Partial<AuthOverride>;
    if (
      typeof data.user === "string" &&
      typeof data.salt === "string" &&
      typeof data.hash === "string"
    ) {
      override = { user: data.user, salt: data.salt, hash: data.hash };
      logger.info("已載入自訂管理員帳密", { path: config.authPath, user: data.user });
    }
  } catch (error) {
    logger.warn("讀取自訂帳密失敗，改用 .env", { error: String(error) });
  }
}

export function currentUser(): string {
  return override?.user || config.status.user || "admin";
}

export function initAuth(): void {
  loadOverride();
  if (override) return;
  if (!config.status.user || !config.status.pass) {
    const pass = crypto.randomBytes(12).toString("base64url");
    config.status.user = config.status.user || "admin";
    config.status.pass = pass;
    logger.warn(
      "未設定 STATUS_USER / STATUS_PASS，已產生臨時登入資訊（重啟會變，建議寫入 .env）",
      { user: config.status.user, pass },
    );
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      // 惡意或損毀的 Cookie 不該讓整個請求 500；保留原始值（不會命中 session）。
      out[key] = rawValue;
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

export function verifyCredentials(user: string, pass: string): boolean {
  if (override) {
    return safeEqual(user, override.user) && safeEqual(hashPassword(pass, override.salt), override.hash);
  }
  return safeEqual(user, config.status.user) && safeEqual(pass, config.status.pass);
}

export function changePassword(
  currentPass: string,
  newPass: string,
): { ok: boolean; error?: string } {
  const user = currentUser();
  if (!verifyCredentials(user, currentPass)) {
    return { ok: false, error: "目前密碼錯誤" };
  }
  if (newPass.length < 6) {
    return { ok: false, error: "新密碼至少需 6 個字元" };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const next: AuthOverride = { user, salt, hash: hashPassword(newPass, salt) };
  try {
    mkdirSync(dirname(config.authPath), { recursive: true });
    writeFileSync(config.authPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (error) {
    return { ok: false, error: `寫入失敗：${String(error)}` };
  }
  override = next;
  clearSessions();
  logger.info("管理員密碼已更新", { path: config.authPath });
  return { ok: true };
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.header("x-forwarded-proto") ?? "");
  return proto.split(",")[0]?.trim() === "https";
}

export function createSession(req: Request, res: Response): void {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  const secure = isSecureRequest(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
}

export function destroySession(req: Request, res: Response): void {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) sessions.delete(token);
  const secure = isSecureRequest(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function sessionValid(req: Request, extend = false): boolean {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  if (extend) sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

/** 回傳目前 session 剩餘毫秒數；無效回 null。extend=true 會同時續期並回傳完整 TTL。 */
export function sessionRemainingMs(req: Request, extend = false): number | null {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  if (extend) {
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return SESSION_TTL_MS;
  }
  return expiresAt - Date.now();
}

export function hasSession(req: Request): boolean {
  return sessionValid(req, true);
}

/** 清除所有登入 session（改密碼後呼叫，避免舊 session 續命）。 */
export function clearSessions(): void {
  sessions.clear();
}

function originMatchesHost(req: Request): boolean {
  const host = String(req.header("host") ?? "").trim().toLowerCase();
  if (!host) return false;
  const check = (value: string): boolean => {
    try {
      return new URL(value, `http://${host}`).host.toLowerCase() === host;
    } catch {
      return false;
    }
  };
  const origin = req.header("origin");
  if (origin) return check(origin);
  const referer = req.header("referer");
  if (referer) return check(referer);
  return false;
}

/**
 * 簡易 CSRF 防護：帶有 session cookie 的非安全方法（POST/PUT/PATCH/DELETE）
 * 必須附上與 Host 一致的 Origin/Referer，否則拒絕。
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  let hasCookie = false;
  try {
    hasCookie = Boolean(parseCookies(req)[COOKIE_NAME]);
  } catch {
    hasCookie = false;
  }
  if (!hasCookie) {
    next();
    return;
  }
  if (originMatchesHost(req)) {
    next();
    return;
  }
  logger.warn("疑似 CSRF 請求被拒", { ip: req.ip, path: req.path });
  res.status(403).json({ ok: false, error: "來源驗證失敗" });
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (sessionValid(req, false)) {
    next();
    return;
  }
  if (req.method !== "GET" || req.path.endsWith(".json")) {
    res.status(401).json({ ok: false, error: "需要登入" });
    return;
  }
  res.redirect("/login");
}

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt < now) sessions.delete(token);
  }
}, 60_000).unref();
