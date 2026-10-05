import crypto from "node:crypto";

/**
 * 固定時間字串比對，避免以回應時間洩漏密鑰。
 * 全專案統一用此函式（取代各處重複實作）。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}
