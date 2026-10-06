import { config } from "../config.js";
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
    text: { level: "native", note: "" },
    image: { level: "native", note: "" },
    video: { level: "native", note: "" },
    audio: { level: "native", note: "" },
    file: { level: "native", note: "" },
    sticker: { level: "degraded", note: "貼圖將以降級文字說明送出（Discord 無對應貼圖）" },
    location: { level: "degraded", note: "位置將以文字 + Google 地圖連結送出" },
    flex: { level: "degraded", note: "Flex 將轉為 Embed（標題＋文字）送出" },
  },
};

/** LINE 官方模式（`line.mode = "official"`）的能力差異；其餘平台與 selfbot 一致。 */
const LINE_OFFICIAL_NOTES: Partial<Record<Capability, CapabilityInfo>> = {
  text: { level: "native", note: "單則上限 5000 字元，超過自動分段" },
  image: { level: "native", note: "來源需為 HTTPS；本機檔案會自動轉為有時效的簽章公開連結" },
  video: { level: "native", note: "來源需為 HTTPS；本機檔案會自動轉為有時效的簽章公開連結" },
  file: { level: "native", note: "來源需為 HTTPS；本機檔案會自動轉為有時效的簽章公開連結" },
  audio: { level: "degraded", note: "需長度資訊；抓不到長度（如遠端音訊）會改以檔案附件送出" },
  sticker: { level: "degraded", note: "以 LINE 官方貼圖送出；無效或非官方貼圖 ID 會降級為文字說明" },
  flex: { level: "native", note: "Flex 原生呈現（非降級）" },
};

/**
 * 取得平台**目前實際**的能力表。
 * LINE 只有一個 platform id、但有兩種帳號模式擇一（仿 WhatsApp），因此能力必須依模式決定。
 */
export function capabilitiesFor(platform: string): Record<Capability, CapabilityInfo> | undefined {
  const table = (PLATFORM_CAPABILITIES as Record<string, Record<Capability, CapabilityInfo>>)[platform];
  if (!table) return undefined;
  if (platform === "line" && config.line.mode === "official") {
    return { ...table, ...LINE_OFFICIAL_NOTES };
  }
  return table;
}

/** 列出某平台上非原生（降級/不支援）的能力說明，供 /console 送出前提示。 */
export function degradedCapabilities(platform: string): string[] {
  const table = capabilitiesFor(platform);
  if (!table) return [`未知平台：${platform}`];
  const out: string[] = [];
  for (const [kind, info] of Object.entries(table) as Array<[Capability, CapabilityInfo]>) {
    if (info.level !== "native") out.push(`${kind}：${info.note || info.level}`);
  }
  return out;
}
