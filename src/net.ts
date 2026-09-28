/** 共用的對外請求 helper：強制超時與回應大小上限，避免單一慢速/巨大回應卡住服務。 */

export class FetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchLimitError";
  }
}

interface FetchLimits {
  timeoutMs?: number;
  maxBytes?: number;
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
  const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
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
