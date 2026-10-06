import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessage } from "../messages.js";
import { recordSend } from "../stats.js";
import { writeDeadLetter } from "../deadletter.js";
import { setState } from "../state.js";
import { SendQueue } from "../line/queue.js";
import { SendScheduler, type ScheduledJobView } from "../line/scheduler.js";
import { parseCron, nextRun } from "../line/cron.js";
import { watchOptionsToCron } from "../skills/watch.js";
import type { WatchOptions } from "../skills/types.js";
import { dispatchIncoming, dispatchSkillTask, type DispatchDeps } from "../messaging/dispatch.js";
import { chunkReplyText } from "../messaging/text.js";
import { resolveLocalMediaPath } from "../messaging/media.js";
import { seenInbound } from "../messaging/dedup.js";
import { toPublicMediaUrl } from "../media-url.js";
import {
  NotLoggedInError,
  TargetNotFoundError,
  type FlexInput,
  type IMessagingService,
  type IncomingMessage,
  type LocationInput,
  type SendInput,
  type StickerInput,
} from "../messaging/types.js";

const API_BASE = "https://api.line.me";
/** LINE 文字訊息上限 5000 字元；一次請求最多 5 則訊息。 */
const LINE_TEXT_LIMIT = 5000;
const LINE_MESSAGES_PER_REQUEST = 5;
/** replyToken 保證 1 分鐘內有效（最多 20 分鐘）；超過就改走 push。 */
const REPLY_TOKEN_TTL_MS = 60_000;

/** LINE API 的結構化錯誤（狀態碼決定佇列要不要重試）。 */
export class LineApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LineApiError";
    this.status = status;
  }
}

export interface LineMessage {
  type: "text" | "image" | "video" | "audio" | "file" | "sticker" | "location" | "flex";
  text?: string;
  originalContentUrl?: string;
  previewImageUrl?: string;
  duration?: number;
  fileName?: string;
  packageId?: string;
  stickerId?: string;
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  altText?: string;
  contents?: unknown;
}

export interface LineOfficialEvent {
  type?: string;
  replyToken?: string;
  message?: { id?: string; type?: string; text?: string };
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  timestamp?: number;
}

export interface LineOfficialWebhook {
  destination?: string;
  events?: LineOfficialEvent[];
}

/**
 * 驗證 LINE webhook 的 `X-Line-Signature`
 * （base64(HMAC-SHA256(rawBody, channelSecret))）。
 * 未設定 channelSecret 時回 false（呼叫端應拒絕，見 server 路由）。
 */
export function verifyLineSignature(rawBody: Buffer, header: string, channelSecret: string): boolean {
  if (!channelSecret || !header) return false;
  const expected = createHmacBase64(rawBody, channelSecret);
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqualLocal(a, b);
}

/**
 * 把 LINE webhook event 正規化成平台無關訊息。
 * 只收文字訊息；群組/多人房的 chat 取群組 id（回覆才會進對的房間）。
 */
export function normalizeLineEvent(event: LineOfficialEvent | undefined): IncomingMessage | null {
  if (!event || event.type !== "message") return null;
  const msg = event.message;
  if (!msg || msg.type !== "text") return null;
  const text = (msg.text ?? "").trim();
  if (!text) return null;
  const src = event.source;
  if (!src) return null;
  const chat = src.groupId || src.roomId || src.userId;
  if (!chat) return null;
  const fromId = src.userId ?? chat;
  return { chat, fromId, fromName: fromId, chatName: "", text, messageId: msg.id };
}

/**
 * 估算音訊長度（毫秒）：WAV 精確、MP4/M4A（mvhd）精確、MP3 依首幀 bitrate 估計。
 * 認不出來回 null（呼叫端降級成 file 訊息）。
 */
export function mediaDurationMs(buf: Buffer): number | null {
  if (buf.length < 16) return null;
  // WAV：data chunk 大小 / byteRate
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      // fmt payload：format(2) channels(2) sampleRate(4) byteRate(4)…
      if (id === "fmt " && offset + 20 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
      if (id === "data") {
        dataSize = Math.min(size, buf.length - offset - 8);
        if (byteRate > 0 && dataSize > 0) return Math.round((dataSize / byteRate) * 1000);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  }
  // MP4 / M4A：moov → mvhd → timescale / duration
  const mvhd = buf.indexOf("mvhd");
  if (mvhd > 0 && mvhd + 24 <= buf.length) {
    const p = mvhd + 4;
    const version = buf[p];
    if (version === 0) {
      const timescale = buf.readUInt32BE(p + 12);
      const duration = buf.readUInt32BE(p + 16);
      if (timescale > 0) return Math.round((duration / timescale) * 1000);
    } else if (version === 1 && p + 32 <= buf.length) {
      const timescale = buf.readUInt32BE(p + 20);
      const duration = Number(buf.readBigUInt64BE(p + 24));
      if (timescale > 0) return Math.round((duration / timescale) * 1000);
    }
    return null;
  }
  // MP3：略過 ID3v2 → 找第一個 frame → bitrate 估計
  let offset = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    offset = 10 + size + ((buf[5] & 0x10) !== 0 ? 10 : 0);
  }
  for (let i = offset; i + 3 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buf[i + 1] >> 3) & 0x03;
    const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
    if (versionBits === 1 || bitrateIdx === 0 || bitrateIdx === 0x0f) break;
    const table =
      versionBits === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const kbps = table[bitrateIdx];
    if (kbps > 0) return Math.round((buf.length * 8) / (kbps * 1000) * 1000);
    break;
  }
  return null;
}

function audioBytes(source: string): Buffer | null {
  try {
    if (/^data:/i.test(source)) {
      const match = /^data:[^;,]*;base64,(.*)$/is.exec(source);
      return match ? Buffer.from(match[1], "base64") : null;
    }
    if (/^https?:\/\//i.test(source)) return null;
    return readFileSync(resolveLocalMediaPath(source, config.uploadsPath, config.cachePath));
  } catch {
    return null;
  }
}

function fileNameOf(input: SendInput, fallback: string): string {
  if (input.filename && input.filename.trim()) return input.filename.trim();
  const source = input.file ?? input.audio ?? "";
  if (/^https?:\/\//i.test(source)) {
    try {
      const last = new URL(source).pathname.split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch {
      // fallthrough
    }
  }
  if (/^data:/i.test(source)) return fallback;
  try {
    return basename(resolveLocalMediaPath(source, config.uploadsPath, config.cachePath));
  } catch {
    return fallback;
  }
}

/**
 * SendInput → LINE 訊息陣列（純函式，`resolveUrl` 可注入便於測試）。
 * text 會自動依 5000 字元分段；audio 抓不到長度就降級成 file。
 */
export function buildLineMessages(input: SendInput, resolveUrl: (src: string) => string = toPublicMediaUrl): LineMessage[] {
  const out: LineMessage[] = [];
  if (input.text) {
    for (const part of chunkReplyText(input.text, LINE_TEXT_LIMIT)) out.push({ type: "text", text: part });
  }
  if (input.image) {
    const url = resolveUrl(input.image);
    out.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  if (input.video) {
    const url = resolveUrl(input.video);
    out.push({ type: "video", originalContentUrl: url, previewImageUrl: url });
  }
  if (input.audio) {
    const url = resolveUrl(input.audio);
    const bytes = audioBytes(input.audio);
    const duration = bytes ? mediaDurationMs(bytes) : null;
    if (duration && duration > 0) out.push({ type: "audio", originalContentUrl: url, duration });
    else {
      logger.warn("音訊長度未知，降級為檔案訊息（LINE audio 需要 duration）", { file: fileNameOf(input, "audio") });
      out.push({ type: "file", originalContentUrl: url, fileName: fileNameOf(input, "audio.mp3") });
    }
  }
  if (input.file) {
    const url = resolveUrl(input.file);
    out.push({ type: "file", originalContentUrl: url, fileName: fileNameOf(input, "file") });
  }
  if (input.sticker) out.push({ type: "sticker", packageId: input.sticker.packageId, stickerId: input.sticker.stickerId });
  if (input.location) {
    const loc: LocationInput = input.location;
    out.push({
      type: "location",
      title: loc.title || "位置",
      address: loc.address || "",
      latitude: loc.latitude,
      longitude: loc.longitude,
    });
  }
  if (input.flex) {
    const flex: FlexInput = input.flex;
    out.push({ type: "flex", altText: flex.altText || "Flex", contents: flex.contents });
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHmacBase64(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

function timingSafeEqualLocal(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(a, b);
}

export class LineOfficialService implements IMessagingService {
  readonly platform = "line-official" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  /** chat → 剛收到的 replyToken（一次性，讓回覆不佔 push 配額）。 */
  private pendingReply = new Map<string, { token: string; at: number }>();
  private profiles = new Map<string, string>();
  private busy = false;
  private botUserId = "";
  private botDisplayName = "";
  private state: "未登入" | "連線中" | "已登入" | "需人工" = "未登入";

  constructor() {
    this.queue = new SendQueue(() => ({
      maxRetries: config.send.maxRetries,
      retryBaseMs: config.send.retryBaseMs,
      minIntervalMs: config.send.minIntervalMs,
      isPermanent: (error) => {
        if (error instanceof TargetNotFoundError || error instanceof NotLoggedInError) return true;
        if (error instanceof LineApiError) {
          // 429 與 5xx 是暫時性；401/403（token）與 400（參數/目標）重試也不會好。
          return error.status !== 429 && error.status < 500;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/429|rate|頻繁|timeout|逾時|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up/i.test(message)) {
          return false;
        }
        return /40[0-4]|422|invalid|unauthorized|not found|找不到/i.test(message);
      },
    }));
    this.scheduler = new SendScheduler(
      (inputs) => this.sendAdvanced(inputs),
      (job) => dispatchSkillTask(job, this.dispatchDeps()),
      this.schedulesPath(),
    );
  }

  private schedulesPath(): string {
    const dir = dirname(config.schedulesPath);
    const file = basename(config.schedulesPath);
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    const ext = dot >= 0 ? file.slice(dot) : ".json";
    return join(dir, `${stem}-line-official${ext}`);
  }

  private get token(): string {
    return config.lineOfficial.channelAccessToken.trim();
  }

  private get secret(): string {
    return config.lineOfficial.channelSecret.trim();
  }

  // ---------- REST ----------

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.token) throw new NotLoggedInError("LINE 官方");
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new LineApiError(0, `LINE 官方 API 連線失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LineApiError(res.status, `LINE 官方 API 失敗（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ""}`);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      return undefined as T;
    }
  }

  private async pushMessages(to: string, messages: LineMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += LINE_MESSAGES_PER_REQUEST) {
      const batch = messages.slice(i, i + LINE_MESSAGES_PER_REQUEST);
      await this.api("/v2/bot/message/push", { method: "POST", body: JSON.stringify({ to, messages: batch }) });
      if (i + LINE_MESSAGES_PER_REQUEST < messages.length) await delay(config.send.minIntervalMs);
    }
  }

  /**
   * 優先用 replyToken 回覆：**Reply 不佔每月訊息配額**（push 佔）。
   * token 是一次性的且只保證 1 分鐘內有效，取不到或失敗就退回 push。
   */
  private async replyOrPush(chat: string, messages: LineMessage[]): Promise<void> {
    const token = this.takeReplyToken(chat);
    if (token && messages.length > 0) {
      const first = messages.slice(0, LINE_MESSAGES_PER_REQUEST);
      try {
        await this.api("/v2/bot/message/reply", { method: "POST", body: JSON.stringify({ replyToken: token, messages: first }) });
        if (messages.length > LINE_MESSAGES_PER_REQUEST) await this.pushMessages(chat, messages.slice(LINE_MESSAGES_PER_REQUEST));
        return;
      } catch (error) {
        // replyToken 失效/已用過 → 退回 push（不能因此丟訊息）。
        logger.info("LINE reply 失敗，改用 push", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.pushMessages(chat, messages);
  }

  private takeReplyToken(chat: string): string | null {
    const pending = this.pendingReply.get(chat);
    this.pendingReply.delete(chat);
    if (!pending) return null;
    if (Date.now() - pending.at > REPLY_TOKEN_TTL_MS) return null;
    return pending.token;
  }

  // ---------- 生命週期 ----------

  async init(): Promise<void> {
    if (!config.lineOfficial.enabled) {
      logger.info("LINE 官方未啟用，略過初始化");
      return;
    }
    if (!this.token) {
      logger.warn("LINE 官方已啟用但未設定 channel access token，略過");
      return;
    }
    this.state = "連線中";
    try {
      const info = await this.api<{ userId?: string; displayName?: string }>("/v2/bot/info");
      this.botUserId = info?.userId ?? "";
      this.botDisplayName = info?.displayName ?? "";
      this.state = "已登入";
      logger.info("LINE 官方 Bot 已連線", { bot: this.botDisplayName, userId: this.botUserId });
      await this.refreshContacts();
      await this.ensureWebhook();
    } catch (error) {
      this.state = "需人工";
      logger.error("LINE 官方初始化失敗", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 設定 LINE_OFFICIAL_WEBHOOK_URL 時自動註冊；沒設就提示到 Console 手動設定。 */
  private async ensureWebhook(): Promise<void> {
    const url = config.lineOfficial.webhookUrl.trim();
    if (!url) {
      logger.warn("未設定 LINE_OFFICIAL_WEBHOOK_URL，請到 LINE Developers Console 把 Webhook URL 設為 https://<你的網域>/line-official/webhook");
      return;
    }
    try {
      await this.api("/v2/bot/channel/webhook/endpoint", {
        method: "PUT",
        body: JSON.stringify({ endpoint: url }),
      });
      logger.info("LINE 官方 Webhook 已註冊", { url });
    } catch (error) {
      logger.warn("LINE 官方 Webhook 註冊失敗（可到 Console 手動設定）", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!config.lineOfficial.enabled || !this.token) return false;
    try {
      await this.api("/v2/bot/info");
      this.state = "已登入";
      return true;
    } catch {
      this.state = "需人工";
      return false;
    }
  }

  async recover(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.init();
      return true;
    } finally {
      this.busy = false;
    }
  }

  loginStatus(): string {
    return this.state;
  }

  getBotUserId(): string {
    return this.botUserId;
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, id] of Object.entries(config.lineOfficial.targets)) {
      nameToChat.set(name, id);
      if (!chatToName.has(id)) chatToName.set(id, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("LINE 官方目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    // U<32 hex>（用戶）／c<32 hex>（群組）／Ra<32 hex>（多人房）／舊式 32 hex
    if (/^(?:[URc][0-9a-f]{32}|[0-9a-f]{32})$/i.test(trimmed)) return trimmed;
    return null;
  }

  // ---------- 收訊 ----------

  /** 抓使用者顯示名稱（webhook 只給 userId），失敗就回 userId。 */
  private async displayNameOf(userId: string): Promise<string> {
    const cached = this.profiles.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const profile = await this.api<{ displayName?: string }>(`/v2/bot/profile/${encodeURIComponent(userId)}`);
      if (profile?.displayName) name = profile.displayName;
    } catch {
      // 查不到就沿用 userId；快取避免重複打 API。
    }
    this.profiles.set(userId, name);
    if (this.profiles.size > 1000) {
      const oldest = this.profiles.keys().next();
      if (!oldest.done) this.profiles.delete(oldest.value);
    }
    return name;
  }

  async handleIncoming(payload: unknown): Promise<void> {
    const body = payload as LineOfficialWebhook | undefined;
    const events = Array.isArray(body?.events) ? body.events : [];
    for (const event of events) {
      const msg = normalizeLineEvent(event);
      if (!msg) continue;
      if (seenInbound("line-official", msg.messageId)) continue;
      if (event.replyToken) this.pendingReply.set(msg.chat, { token: event.replyToken, at: Date.now() });
      const name = await this.displayNameOf(msg.fromId);
      msg.fromName = name;
      if (!event.source?.groupId && !event.source?.roomId) msg.chatName = name;
      recordMessage({
        time: new Date().toISOString(),
        fromMid: msg.fromId,
        fromName: msg.fromName,
        chatMid: msg.chat,
        chatType: "line-official",
        text: msg.text,
      });
      await dispatchIncoming(msg, this.dispatchDeps());
    }
  }

  private dispatchDeps(): DispatchDeps {
    return {
      platform: "line-official",
      replyTo: (chat, text) => this.replyTo(chat, text),
      sendAdvanced: (inputs) => this.sendAdvanced(inputs),
      sendMedia: (chat, source, kind, filename) => this.sendMedia(chat, source, kind, filename),
      schedule: (inputs, runAt, repeat) => this.schedule(inputs, runAt, repeat),
      scheduleSkillTask: (skillId, chat, opts) => this.scheduleSkillTask(skillId, chat, opts),
      listSkillTasks: (filter) => this.listSkillTasks(filter),
      readTaskState: (id) => this.readTaskState(id),
      saveTaskState: (id, state) => this.saveTaskState(id, state),
      cancelScheduledTask: (id) => this.scheduler.cancel(id),
      enqueueText: (to, text) => this.enqueueText(to, text),
      getQueueStats: () => this.getQueueStats(),
      listScheduled: () => this.listScheduled(),
    };
  }

  // ---------- 發送 ----------

  async enqueueText(to: string, text: string): Promise<void> {
    await this.queue.enqueue(() => this.rawSend(to, text));
  }

  private async rawSend(chat: string, text: string): Promise<void> {
    const id = this.resolveTarget(chat);
    if (!id) throw new TargetNotFoundError(chat);
    const messages: LineMessage[] = chunkReplyText(text, LINE_TEXT_LIMIT).map((part) => ({ type: "text", text: part }));
    await this.replyOrPush(id, messages);
    recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "line-official" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    try {
      await this.rawSend(chat, text);
    } catch (error) {
      recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "line-official" });
      throw error;
    }
  }

  async sendAdvanced(inputs: SendInput[]): Promise<void> {
    const errors: unknown[] = [];
    const messages: string[] = [];
    for (const input of inputs) {
      try {
        await this.queue.enqueue(() => this.sendOne(input));
      } catch (error) {
        errors.push(error);
        messages.push(`${input.to}: ${error instanceof Error ? error.message : String(error)}`);
        recordSend({ time: new Date().toISOString(), to: input.to, type: inputType(input), ok: false, platform: "line-official" });
        writeDeadLetter({
          platform: "line-official",
          kind: "send",
          to: [input.to],
          payload: [input],
          summary: inputType(input),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (errors.length === 1 && errors[0] instanceof Error) throw errors[0];
    if (errors.length > 0) throw new Error(messages.join("; "));
  }

  private async sendOne(input: SendInput): Promise<void> {
    const id = this.resolveTarget(input.to);
    if (!id) throw new TargetNotFoundError(input.to);
    const messages = buildLineMessages(input);
    if (messages.length === 0) return;
    try {
      await this.replyOrPush(id, messages);
    } catch (error) {
      // 貼圖 ID 無效（400）時降級成文字說明，避免整則失敗。
      if (input.sticker && error instanceof LineApiError && error.status === 400) {
        logger.warn("LINE 貼圖送出失敗，降級為文字", { packageId: input.sticker.packageId, stickerId: input.sticker.stickerId });
        await this.replyOrPush(id, [
          { type: "text", text: `（貼圖，LINE 官方 API 無法送出：${input.sticker.packageId}/${input.sticker.stickerId}）` },
        ]);
      } else {
        throw error;
      }
    }
    recordSend({ time: new Date().toISOString(), to: input.to, type: inputType(input), ok: true, platform: "line-official" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async sendMedia(
    chat: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    const input: SendInput = { to: chat, filename };
    if (kind === "image") input.image = source;
    else if (kind === "video") input.video = source;
    else if (kind === "audio") input.audio = source;
    else input.file = source;
    await this.sendOne(input);
  }

  async sendSticker(chat: string, sticker: StickerInput): Promise<void> {
    await this.sendOne({ to: chat, sticker });
  }

  // ---------- IMessagingService 排程 / 狀態 ----------

  schedule(inputs: SendInput[], runAt: number, repeat?: string): ScheduledJobView {
    return this.scheduler.add(inputs, runAt, repeat);
  }

  updateScheduled(id: string, patch: { runAt?: number; repeat?: string | null }): ScheduledJobView | null {
    return this.scheduler.update(id, patch);
  }

  listScheduled(): ScheduledJobView[] {
    return this.scheduler.list();
  }

  cancelScheduled(id: string): boolean {
    return this.scheduler.cancel(id);
  }

  listTargets(): Array<{ name: string; id: string }> {
    return [...this.nameToChat.entries()].map(([name, id]) => ({ name, id }));
  }

  getQueueStats(): { pending: number; running: boolean } {
    return this.queue.stats();
  }

  saveTaskState(id: string, state: Record<string, unknown>): boolean {
    return this.scheduler.saveSkillState(id, state);
  }

  scheduleSkillTask(skillId: string, chat: string, opts: WatchOptions): ScheduledJobView {
    const cron = watchOptionsToCron(opts);
    const runAt = nextRun(parseCron(cron), Date.now(), config.timezone);
    if (runAt === null) throw new Error("無效的排程：一年內無符合時間");
    for (const existing of this.scheduler.list()) {
      const st = existing.skillTask;
      if (st && st.skillId === skillId && st.task === opts.task && st.chat === chat) {
        this.scheduler.cancel(existing.id);
      }
    }
    return this.scheduler.add([], runAt, cron, {
      skillId,
      task: opts.task,
      chat,
      args: { ...(opts.args ?? {}) },
      state: { ...(opts.state ?? {}) },
    });
  }

  readTaskState(id: string): Record<string, unknown> | undefined {
    const ref = this.scheduler.getSkillTask(id);
    const state = ref?.state;
    return state ? { ...state } : undefined;
  }

  listSkillTasks(filter?: { skillId?: string; chat?: string }): ScheduledJobView[] {
    return this.scheduler.list().filter((job) => {
      const st = job.skillTask;
      if (!st) return false;
      if (filter?.skillId && st.skillId !== filter.skillId) return false;
      if (filter?.chat && st.chat !== filter.chat) return false;
      return true;
    });
  }

  stopListening(): void {
    this.pendingReply.clear();
    this.profiles.clear();
  }

  stopQueue(): void {
    this.queue.stop();
    this.scheduler.stop();
  }
}

function inputType(input: SendInput): string {
  if (input.image) return "image";
  if (input.video) return "video";
  if (input.audio) return "audio";
  if (input.file) return "file";
  if (input.sticker) return "sticker";
  if (input.location) return "location";
  if (input.flex) return "flex";
  if (input.text) return "text";
  return "unknown";
}
