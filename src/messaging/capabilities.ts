import type { Platform } from "./types.js";

/** 訊息能力種類。 */
export type Capability = "text" | "image" | "video" | "audio" | "file" | "sticker" | "location" | "flex";

export type CapabilityLevel = "native" | "degraded" | "unsupported";

export interface CapabilityInfo {
  level: CapabilityLevel;
  /** 降級/不支援時的說明（中文，顯示於 /console 提示）。 */
  note: string;
}

/**
 * 平台能力矩陣（E3）：單一宣告表，文件與 UI 都由此生成，避免兩邊不同步。
 * degraded = 會送出但形式改變（事前告知而非靜默）。
 */
export const PLATFORM_CAPABILITIES: Record<Platform, Record<Capability, CapabilityInfo>> = {
  line: {
    text: { level: "native", note: "" },
    image: { level: "native", note: "" },
    video: { level: "native", note: "" },
    audio: { level: "native", note: "" },
    file: { level: "native", note: "" },
    sticker: { level: "native", note: "" },
    location: { level: "native", note: "" },
    flex: { level: "native", note: "" },
  },
  telegram: {
    text: { level: "native", note: "" },
    image: { level: "native", note: "" },
    video: { level: "native", note: "" },
    audio: { level: "native", note: "" },
    file: { level: "native", note: "" },
    sticker: { level: "degraded", note: "貼圖將以降級文字說明送出（Telegram 無對應貼圖）" },
    location: { level: "native", note: "" },
    flex: { level: "degraded", note: "Flex 將只送出 altText 文字（Telegram 無 Flex）" },
  },
  whatsapp: {
    text: { level: "native", note: "" },
    image: { level: "native", note: "" },
    video: { level: "native", note: "" },
    audio: { level: "native", note: "" },
    file: { level: "native", note: "" },
    sticker: { level: "degraded", note: "貼圖將以降級文字說明送出" },
    location: { level: "native", note: "" },
    flex: { level: "degraded", note: "Flex 將只送出 altText 文字；主動推播另受 24 小時視窗限制" },
  },
  teams: {
    text: { level: "native", note: "" },
    image: { level: "native", note: "" },
    video: { level: "native", note: "" },
    audio: { level: "native", note: "" },
    file: { level: "native", note: "" },
    sticker: { level: "degraded", note: "貼圖將以降級文字說明送出" },
    location: { level: "degraded", note: "位置將以文字 + Bing 地圖連結送出" },
    flex: { level: "native", note: "Flex 轉譯為 Adaptive Card 呈現" },
  },
  discord: {
    text: { level: "unsupported", note: "Discord 尚未實作" },
    image: { level: "unsupported", note: "Discord 尚未實作" },
    video: { level: "unsupported", note: "Discord 尚未實作" },
    audio: { level: "unsupported", note: "Discord 尚未實作" },
    file: { level: "unsupported", note: "Discord 尚未實作" },
    sticker: { level: "unsupported", note: "Discord 尚未實作" },
    location: { level: "unsupported", note: "Discord 尚未實作" },
    flex: { level: "unsupported", note: "Discord 尚未實作" },
  },
};

/** 列出某平台上非原生（降級/不支援）的能力說明，供 /console 送出前提示。 */
export function degradedCapabilities(platform: string): string[] {
  const table = (PLATFORM_CAPABILITIES as Record<string, Record<Capability, CapabilityInfo>>)[platform];
  if (!table) return [`未知平台：${platform}`];
  const out: string[] = [];
  for (const [kind, info] of Object.entries(table) as Array<[Capability, CapabilityInfo]>) {
    if (info.level !== "native") out.push(`${kind}：${info.note || info.level}`);
  }
  return out;
}
