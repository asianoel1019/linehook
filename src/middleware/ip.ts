import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";

export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * 取得「有效客戶端 IP」。app 已設 trust proxy，故 req.ip 會是
 * X-Forwarded-For 最左側的值（nginx 以 $remote_addr 覆寫即為真實來源）；
 * 沒有經過 proxy 時則為 socket 位址。
 */
export function clientIp(req: Request): string {
  return normalizeIp(req.ip || req.socket.remoteAddress || undefined);
}

export function isPrivateAddress(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (!addr) return false;
  if (addr === "::1" || addr === "localhost") return true;
  if (addr.startsWith("fc") || addr.startsWith("fd") || addr.startsWith("fe80:")) return true;

  const parts = addr.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isPrivateRequest(req: Request): boolean {
  return isPrivateAddress(clientIp(req));
}

export function isIpAllowed(req: Request): boolean {
  if (config.allowedIps.length === 0) return true;
  const allowed = new Set(config.allowedIps.map(normalizeIp));
  return allowed.has(clientIp(req));
}

export function ipGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isIpAllowed(req)) {
    logger.warn("來源 IP 被拒絕", { ip: clientIp(req) });
    res.status(403).json({ ok: false, error: "來源 IP 未授權" });
    return;
  }
  next();
}
