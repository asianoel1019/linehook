import type { ScheduledJobView } from "../line/scheduler.js";

/** 支援的通訊平台。新增 adapter 時擴充此 union 即可。 */
export type Platform = "line" | "telegram" | "teams" | "whatsapp" | "discord";

/** 目標對照（一列）：顯示名稱 → 平台原生 ID（LINE 的 mid、Telegram 的 chat_id…）。 */
export interface ChatTarget {
  name: string;
  id: string;
}

export interface QueueStats {
  pending: number;
  running: boolean;
}

/** 平台無關的收到訊息。adapter 負責把各平台格式正規化成這個形狀。 */
export interface IncomingMessage {
  /** 對話 ID（私聊即對方 ID，群組即群組 ID）。 */
  chat: string;
  /** 發送者使用者 ID。 */
  fromId: string;
  fromName: string;
  chatName: string;
  text: string;
}

export interface StickerInput {
  packageId: string;
  stickerId: string;
  version?: string;
}

export interface LocationInput {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface FlexInput {
  altText: string;
  contents: Record<string, unknown>;
}

export interface SendInput {
  to: string;
  text?: string;
  file?: string;
  image?: string;
  video?: string;
  audio?: string;
  filename?: string;
  sticker?: StickerInput;
  location?: LocationInput;
  flex?: FlexInput;
}

/** 找不到目標（名稱或 ID 無法解析）。 */
export class TargetNotFoundError extends Error {
  constructor(to: string) {
    super(`找不到目標：${to}`);
    this.name = "TargetNotFoundError";
  }
}

/** 尚未登入／未設定（LINE 未登入、Telegram 未設 token 等）。 */
export class NotLoggedInError extends Error {
  constructor(platform = "") {
    super(platform ? `${platform} 尚未登入` : "尚未登入");
    this.name = "NotLoggedInError";
  }
}

/**
 * 各通訊軟體共用的服務介面。
 * server.ts / monitor / index.ts 只依賴此介面；LineService 只是其中一個實作。
 */
export interface IMessagingService {
  readonly platform: Platform;

  init(): Promise<void>;
  healthCheck(): Promise<boolean>;
  recover(): Promise<boolean>;

  sendAdvanced(inputs: SendInput[]): Promise<void>;

  schedule(inputs: SendInput[], runAt: number, repeat?: string): ScheduledJobView;
  updateScheduled(
    id: string,
    patch: { runAt?: number; repeat?: string | null },
  ): ScheduledJobView | null;
  listScheduled(): ScheduledJobView[];
  cancelScheduled(id: string): boolean;

  listTargets(): ChatTarget[];
  refreshContacts(): Promise<void>;
  getQueueStats(): QueueStats;

  /**
   * 接收型平台（webhook / polling）用：處理一筆原始進站事件。
   * LINE 走 linejs 事件監聽，不實作此方法。
   */
  handleIncoming?(payload: unknown): Promise<void>;

  stopListening(): void;
  stopQueue(): void;
}
