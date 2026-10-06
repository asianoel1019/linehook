import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { resolveLocalMediaPath } from "./messaging/media.js";
import { uploadHasRoom } from "./uploads.js";

/**
 * 本機媒體 → 公開連結（E2）。
 *
 * LINE 官方 Messaging API 的 image / video / audio / file 訊息**只收 HTTPS URL**，
 * 沒有「上傳二進位」的 API（只有 rich menu 圖片可上傳）。因此要把 `data/uploads` 內的
 * 檔案送給 LINE，就必須提供一個對外可抓取的網址。
 *
 * 做法：以 HMAC 簽章 + 時效（24 小時）的路徑提供檔案，避免上傳目錄被任意列舉。
 * 簽章金鑰 = `MEDIA_SIGN_SECRET`（若有）否则 `HMAC_SECRET` / `WEBHOOK_TOKEN` / `API_TOKEN`。
 */

const URL_TTL_SEC = 24 * 60 * 60;
/** 簽章 URL 的最長可接受壽命（防止自己簽出超長命的連結）。 */
const MAX_LIFETIME_SEC = 7 * 24 * 60 * 60;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

function signKey(): string {
  const key = process.env.MEDIA_SIGN_SECRET?.trim() || config.hmacSecret || config.webhookToken || config.apiToken;
  if (!key) {
    throw new Error(
      "無法產生媒體簽章 URL：未設定 MEDIA_SIGN_SECRET，且 HMAC_SECRET／WEBHOOK_TOKEN／API_TOKEN 皆為空；請先於 /settings 設定其中一項",
    );
  }
  return key;
}

function hmac(exp: number, name: string): string {
  return createHmac("sha256", signKey()).update(`media:${exp}:${name}`).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 產生 `${base}/media/${exp}/${sig}/${name}`。 */
export function buildMediaPath(name: string, nowSec = Math.floor(Date.now() / 1000)): { exp: number; sig: string } {
  const exp = nowSec + URL_TTL_SEC;
  return { exp, sig: hmac(exp, name) };
}

/** 驗證公開媒體路徑的簽章與時效（供 /media 路由使用）。 */
export function verifyMediaSignature(exp: number, sig: string, name: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(exp) || !Number.isInteger(exp)) return false;
  if (exp < nowSec) return false;
  if (exp > nowSec + MAX_LIFETIME_SEC) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  try {
    return equalHex(sig, hmac(exp, name));
  } catch {
    return false;
  }
}

function base(): string {
  const value = config.mediaPublicUrl.trim().replace(/\/+$/, "");
  if (!value) {
    throw new Error(
      "未設定 MEDIA_PUBLIC_URL（本服務對外 https 網址），LINE 無法抓取本機檔案；請於 .env 設定，例如 https://example.com",
    );
  }
  return value;
}

function rootRelative(absPath: string): string {
  const roots = [resolve(config.uploadsPath), resolve(config.cachePath)];
  for (const root of roots) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (absPath.startsWith(prefix)) return absPath.slice(prefix.length).split(sep).join("/");
  }
  throw new Error("檔案不在上傳／快取目錄內");
}

function persistDataUrl(source: string): string {
  const match = /^data:([^;,]*);base64,(.*)$/is.exec(source);
  if (!match) throw new Error("不支援的 data URL 格式（需 base64）");
  const mime = match[1] || "application/octet-stream";
  const extFromMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
  };
  const ext = extFromMime[mime] ?? "bin";
  const data = Buffer.from(match[2], "base64");
  if (data.length === 0) throw new Error("data URL 內容為空");
  if (!uploadHasRoom(data.length)) throw new Error("上傳空間已滿，無法暫存 data URL 媒體");
  const name = `data-${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`;
  mkdirSync(config.uploadsPath, { recursive: true });
  writeFileSync(resolve(config.uploadsPath, name), data);
  logger.info("已把 data URL 媒體暫存到上傳目錄", { file: name, bytes: data.length });
  return name;
}

/**
 * 把來源轉成 LINE 可抓取的公開 URL。
 * - `https://` 原樣回傳（LINE 只收 HTTPS；`http://` 會原樣帶出並記 warn，由 LINE 拒絕）
 * - `data:` 解碼後暫存到上傳目錄
 * - 其餘視為本機路徑（限上傳／快取目錄），轉成簽章 URL
 */
export function toPublicMediaUrl(source: string): string {
  if (/^https:\/\//i.test(source)) return source;
  if (/^http:\/\//i.test(source)) {
    logger.warn("LINE 需要 HTTPS 媒體網址，http:// 將被平台拒絕", { url: source });
    return source;
  }
  const name = /^data:/i.test(source) ? persistDataUrl(source) : rootRelative(resolveLocalMediaPath(source, config.uploadsPath, config.cachePath));
  const { exp, sig } = buildMediaPath(name);
  return `${base()}/media/${exp}/${sig}/${encodeURIComponent(name)}`;
}

/** 依檔名解析公開媒體路徑的實際檔案（限上傳／快取目錄的直接子檔）。 */
export function resolveMediaFile(name: string): string | null {
  const safe = basename(name);
  if (!safe || safe !== name || safe.includes("..")) return null;
  for (const root of [resolve(config.uploadsPath), resolve(config.cachePath)]) {
    const candidate = resolve(root, safe);
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (!candidate.startsWith(prefix)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
