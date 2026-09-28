import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface TokenUsage {
  name: string;
  count: number;
  lastUsedAt: string | null;
  lastIp: string | null;
}

const stats = new Map<string, TokenUsage>();
let dirty = false;

function usagePath(): string {
  return join(dirname(config.statsPath), "token-usage.json");
}

export function initTokenStats(): void {
  const path = usagePath();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;
    stats.clear();
    for (const item of raw) {
      const u = item as Partial<TokenUsage>;
      if (typeof u.name !== "string") continue;
      stats.set(u.name, {
        name: u.name,
        count: typeof u.count === "number" && u.count >= 0 ? Math.floor(u.count) : 0,
        lastUsedAt: typeof u.lastUsedAt === "string" ? u.lastUsedAt : null,
        lastIp: typeof u.lastIp === "string" ? u.lastIp : null,
      });
    }
    logger.info("已載入 Token 用量統計", { path, count: stats.size });
  } catch (error) {
    logger.warn("載入 Token 用量統計失敗", { error: String(error) });
  }
}

export function recordTokenUsage(name: string, ip: string): void {
  const key = name || "(主 Token)";
  const prev = stats.get(key);
  stats.set(key, {
    name: key,
    count: (prev?.count ?? 0) + 1,
    lastUsedAt: new Date().toISOString(),
    lastIp: ip || null,
  });
  dirty = true;
}

export function getTokenUsage(): TokenUsage[] {
  return [...stats.values()].sort((a, b) => b.count - a.count);
}

export function flushTokenStats(): void {
  if (!dirty) return;
  dirty = false;
  try {
    const path = usagePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...stats.values()], null, 2), "utf8");
  } catch (error) {
    logger.warn("寫入 Token 用量統計失敗", { error: String(error) });
  }
}

setInterval(() => {
  flushTokenStats();
}, 60_000).unref();
