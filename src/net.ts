/** 共用的對外請求 helper：強制超時與回應大小上限，避免單一慢速/巨大回應卡住服務。 */

import { lookup } from "node:dns/promises";

export class FetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchLimitError";
  }
}

/** SSRF 阻擋錯誤（內網/特殊位址）。 */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

interface FetchLimits {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * 阻擋內網位址（B4）：解析 hostname 後若為 loopback／private／link-local／
   * multicast／保留網段／雲端 metadata（169.254.169.254、100.100.100.100）即拒絕。
   * 預設 false（相容既有行為）；使用者可指定 URL 的入口（summarize 等）應開啟。
   */
  blockPrivate?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function limitsOf(options?: FetchLimits): { timeoutMs: number; maxBytes: number } {
  return {
    timeoutMs: options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBytes: options?.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES,
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = res.headers.get("content-length");
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new FetchLimitError(`回應過大（${declared} bytes，上限 ${maxBytes}）`);
    }
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new FetchLimitError(`回應過大（上限 ${maxBytes} bytes）`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FetchLimitError(`回應過大（上限 ${maxBytes} bytes）`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 帶超時與大小上限的 fetch，回傳原始 Response（body 尚未讀取）。 */
export async function fetchWithLimits(
  url: string,
  init?: RequestInit,
  options?: FetchLimits,
): Promise<Response> {
  const { timeoutMs } = limitsOf(options);
  if (options?.blockPrivate) await assertPublicUrl(url);
  const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}

function isPrivateV4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local（含 169.254.169.254）
  if (a === 0) return true;
  if (a >= 224 && a <= 239) return true; // multicast
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT（含阿里雲 100.100.100.100）
  if (a === 192 && (b === 0 || b === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a === 192 && b === 88 && parts[2] === 99) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::1" || n === "::") return true;
  if (n.startsWith("fe80:") || n.startsWith("fe90:") || n.startsWith("fea") || n.startsWith("feb")) return true;
  if (n.startsWith("fc") || n.startsWith("fd")) return true;
  if (n.startsWith("ff")) return true;
  if (n.startsWith("::ffff:")) {
    const v4 = n.slice(7).split(".").map(Number);
    if (v4.length === 4 && v4.every((x) => Number.isInteger(x))) return isPrivateV4(v4);
  }
  return false;
}

/** 解析並阻擋內網/特殊位址；公開位址才放行。 */
export async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedHostError(`URL 無效：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedHostError(`不支援的協定：${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new BlockedHostError(`內網主機不允許：${host}`);
  }
  let address: string;
  try {
    const result = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS 逾時")), 5000)),
    ]);
    address = result.address;
  } catch (error) {
    throw new BlockedHostError(`主機解析失敗：${host}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const blocked = address.includes(":") ? isPrivateV6(address) : isPrivateV4(address.split(".").map(Number));
  if (blocked) throw new BlockedHostError(`內網位址不允許：${host} (${address})`);
}

export async function fetchBuffer(url: string, init?: RequestInit, options?: FetchLimits): Promise<Buffer> {
  const { maxBytes } = limitsOf(options);
  const res = await fetchWithLimits(url, init, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await readCapped(res, maxBytes));
}

export async function fetchText(
  url: string,
  init?: RequestInit,
  options?: FetchLimits,
): Promise<string> {
  const buf = await fetchBuffer(url, init, options);
  return buf.toString("utf8");
}

export async function fetchJson<T>(url: string, init?: RequestInit, options?: FetchLimits): Promise<T> {
  const text = await fetchText(url, init, options);
  return JSON.parse(text) as T;
}
