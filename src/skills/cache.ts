import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface CacheEntry<T> {
  savedAt: number;
  value: T;
}

function fileFor(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, "_");
  return resolve(config.cachePath, `${safe}.json`);
}

/**
 * 讀取持久化快取。若不存在或已超過 ttlMs（0 或未設定視為預設 60 分鐘）則回 null。
 */
export function readCache<T>(name: string, ttlMs: number): T | null {
  const path = fileFor(name);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
    if (typeof entry.savedAt !== "number") return null;
    const ttl = ttlMs > 0 ? ttlMs : 60 * 60 * 1000;
    if (Date.now() - entry.savedAt > ttl) return null;
    return entry.value;
  } catch (error) {
    logger.warn("讀取快取失敗", { name, error: String(error) });
    return null;
  }
}

/** 寫入持久化快取（data/cache/<name>.json）。 */
export function writeCache<T>(name: string, value: T): void {
  try {
    mkdirSync(config.cachePath, { recursive: true });
    const entry: CacheEntry<T> = { savedAt: Date.now(), value };
    writeFileSync(fileFor(name), JSON.stringify(entry), "utf8");
  } catch (error) {
    logger.warn("寫入快取失敗", { name, error: String(error) });
  }
}

/** 解析 TTL 設定字串（支援「60」(分鐘)、「30m」、「2h」、「90s」）；未設定或無效回預設（毫秒）。 */
export function parseTtl(raw: string | undefined, fallbackMinutes = 60): number {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return fallbackMinutes * 60 * 1000;
  const m = value.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/);
  if (!m) return fallbackMinutes * 60 * 1000;
  const num = Number(m[1]);
  const unit = m[2] ?? "m";
  const ms = unit === "s" ? num * 1000 : unit === "h" ? num * 3600_000 : num * 60_000;
  return ms > 0 ? ms : fallbackMinutes * 60 * 1000;
}
