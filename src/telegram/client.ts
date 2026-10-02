import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessage } from "../messages.js";
import { recordSend } from "../stats.js";
import { setState } from "../state.js";
import { SendQueue } from "../line/queue.js";
import { SendScheduler, type ScheduledJobView } from "../line/scheduler.js";
import { parseCron, nextRun } from "../line/cron.js";
import { watchOptionsToCron } from "../skills/watch.js";
import type { WatchOptions } from "../skills/types.js";
import { dispatchIncoming, dispatchSkillTask, type DispatchDeps } from "../messaging/dispatch.js";
import { chunkReplyText } from "../messaging/text.js";
import { resolveLocalMediaPath } from "../messaging/media.js";
import { fetchWithLimits } from "../net.js";
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
import { fetchJson as netFetchJson } from "../net.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extFor(kind: string, mime?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("pdf")) return "pdf";
  if (kind === "image") return "png";
  if (kind === "video") return "mp4";
  if (kind === "audio") return "mp3";
  return "bin";
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgChat {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: TgUser;
    chat: TgChat;
    text?: string;
    caption?: string;
  };
}

interface TgApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** 把 Telegram update 正規化成平台無關訊息；非文字訊息或機器人自己回 null。 */
export function normalizeTelegramUpdate(update: TgUpdate): IncomingMessage | null {
  const msg = update?.message;
  if (!msg || !msg.from || !msg.chat) return null;
  if (msg.from.is_bot) return null;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!text) return null;
  const chat = String(msg.chat.id);
  const fromId = String(msg.from.id);
  const fromName = msg.from.username
    ? `@${msg.from.username}`
    : `${msg.from.first_name ?? ""} ${msg.from.last_name ?? ""}`.trim() || fromId;
  const chatName = msg.chat.title
    || (msg.chat.username ? `@${msg.chat.username}` : "")
    || `${msg.chat.first_name ?? ""} ${msg.chat.last_name ?? ""}`.trim();
  return { chat, fromId, fromName, chatName, text };
}

export class TelegramService implements IMessagingService {
  readonly platform = "telegram" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  private busy = false;
  private botUsername = "";

  constructor() {
    this.queue = new SendQueue(() => ({
      maxRetries: config.send.maxRetries,
      retryBaseMs: config.send.retryBaseMs,
      minIntervalMs: config.send.minIntervalMs,
      isPermanent: (error) => {
        if (error instanceof TargetNotFoundError || error instanceof NotLoggedInError) return true;
        const message = error instanceof Error ? error.message : String(error);
        // 明顯的暫時性錯誤（限流/逾時/連線）一定要重試。
        if (/429|rate|頻繁|timeout|逾時|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|retry after/i.test(message)) {
          return false;
        }
        // 參數/驗證類錯誤重試也不會成功，直接失敗避免卡住佇列。
        return /40[0-4]|422|chat not found|bot was blocked|deactivated|unauthorized|wrong|驗證失敗|參數錯誤|不支援|格式錯誤|找不到/i.test(message);
      },
    }));
    this.scheduler = new SendScheduler(
      (inputs) => this.sendAdvanced(inputs),
      (job) => dispatchSkillTask(job, this.dispatchDeps()),
      this.schedulesPath(),
    );
  }

  private schedulesPath(): string {
    // 與 LINE 共用目錄，檔名加 -telegram 後綴，避免兩邊排程互蓋。
    const dir = dirname(config.schedulesPath);
    const file = basename(config.schedulesPath);
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    const ext = dot >= 0 ? file.slice(dot) : ".json";
    return join(dir, `${stem}-telegram${ext}`);
  }

  private get token(): string {
    return config.telegram.botToken.trim();
  }

  private baseUrl(): string {
    return `https://api.telegram.org/bot${this.token}/`;
  }

  private async api<T>(method: string, params?: Record<string, unknown>, form?: FormData): Promise<T> {
    if (!this.token) throw new NotLoggedInError("Telegram");
    let res: Response;
    try {
      if (form) {
        res = await fetchWithLimits(this.baseUrl() + method, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        res = await fetch(this.baseUrl() + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params ?? {}),
          signal: AbortSignal.timeout(20_000),
        });
      }
    } catch (error) {
      throw new Error(`Telegram API 連線失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    let data: TgApiResult<T>;
    try {
      data = (await res.json()) as TgApiResult<T>;
    } catch {
      throw new Error(`Telegram API 回應解析失敗（HTTP ${res.status}）`);
    }
    if (!data.ok) throw new Error(data.description || `Telegram API 錯誤（${method}）`);
    return data.result as T;
  }

  async init(): Promise<void> {
    if (!config.telegram.enabled || !this.token) {
      logger.info("Telegram 未啟用（未設定 botToken），略過初始化");
      return;
    }
    try {
      const me = await this.api<{ username?: string; first_name?: string }>("getMe");
      this.botUsername = me.username ?? "";
      logger.info("Telegram Bot 已連線", { username: this.botUsername ? `@${this.botUsername}` : "" });
      await this.refreshContacts();
      const webhookUrl = config.telegram.webhookUrl.trim();
      if (webhookUrl) {
        await this.registerWebhook(webhookUrl);
      } else {
        logger.warn("Telegram 未設定 webhookUrl，請手動 setWebhook 到 POST /tg/update（或填 webhookUrl 後重啟）");
      }
    } catch (error) {
      logger.error("Telegram 初始化失敗", { error: String(error) });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!config.telegram.enabled || !this.token) return false;
    try {
      await this.api("getMe");
      return true;
    } catch {
      return false;
    }
  }

  async recover(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.init();
      return true;
    } catch (error) {
      logger.error("Telegram 重連失敗", { error: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  async registerWebhook(url: string): Promise<void> {
    const params: Record<string, unknown> = {
      url,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    };
    if (config.telegram.secretToken.trim()) {
      params.secret_token = config.telegram.secretToken.trim();
    }
    await this.api("setWebhook", params);
    logger.info("Telegram webhook 已註冊", { url });
  }

  getBotUsername(): string {
    return this.botUsername;
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, id] of Object.entries(config.telegram.targets)) {
      nameToChat.set(name, id);
      if (!chatToName.has(id)) chatToName.set(id, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("Telegram 目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    if (/^-?\d+$/.test(trimmed) || /^@[\w_]{5,}$/i.test(trimmed)) return trimmed;
    return null;
  }

  /** 把 Telegram update 正規化成平台無關訊息；非文字訊息或機器人自己回 null。 */
  normalizeUpdate(update: TgUpdate): IncomingMessage | null {
    return normalizeTelegramUpdate(update);
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = this.normalizeUpdate(update);
    if (!msg) return;
    recordMessage({
      time: new Date().toISOString(),
      fromMid: msg.fromId,
      fromName: msg.fromName,
      chatMid: msg.chat,
      chatType: "telegram",
      text: msg.text,
    });
    await dispatchIncoming(msg, this.dispatchDeps());
  }

  /** IMessagingService 接收入口：把原始 update payload 交給 handleUpdate。 */
  async handleIncoming(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const update = payload as TgUpdate;
    if (typeof update.update_id !== "number") return;
    await this.handleUpdate(update);
  }

  private dispatchDeps(): DispatchDeps {
    return {
      platform: "telegram",
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

  async enqueueText(to: string, text: string): Promise<void> {
    await this.queue.enqueue(() => this.rawSend(to, text));
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

  private async rawSend(chatId: string, text: string): Promise<void> {
    const id = this.resolveTarget(chatId);
    if (!id) throw new TargetNotFoundError(chatId);
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.api("sendMessage", { chat_id: id, text: part });
      recordSend({ time: new Date().toISOString(), to: chatId, type: "text", ok: true, platform: "telegram" });
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
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
        recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: false, platform: "telegram" });
      }
    }
    if (errors.length === 1 && errors[0] instanceof Error) throw errors[0];
    if (errors.length > 0) throw new Error(messages.join("; "));
  }

  private inputType(input: SendInput): string {
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

  private async sendOne(input: SendInput): Promise<void> {
    const id = this.resolveTarget(input.to);
    if (!id) throw new TargetNotFoundError(input.to);

    if (input.image) await this.sendMedia(id, input.image, "image", input.filename);
    if (input.video) await this.sendMedia(id, input.video, "video", input.filename);
    if (input.audio) await this.sendMedia(id, input.audio, "audio", input.filename);
    if (input.file) await this.sendMedia(id, input.file, "file", input.filename);
    if (input.sticker) await this.sendSticker(id, input.sticker);
    if (input.location) await this.sendLocation(id, input.location);
    if (input.flex) await this.sendFlex(id, input.flex);
    if (input.text) await this.rawSendText(id, input.text);

    recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: true, platform: "telegram" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async rawSendText(chatId: string, text: string): Promise<void> {
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.api("sendMessage", { chat_id: chatId, text: part });
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const id = this.resolveTarget(chat) ?? chat;
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      try {
        await this.api("sendMessage", { chat_id: id, text: part });
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "telegram" });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "telegram" });
        throw error;
      }
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async loadMediaBytes(source: string, kind: string, filename?: string): Promise<{ data: Buffer; name: string }> {
    const maxBytes = Math.max(1, config.maxBodyMb) * 1024 * 1024;
    const dataUrl = /^data:([^;,]*);base64,(.*)$/is.exec(source);
    if (dataUrl) {
      const data = Buffer.from(dataUrl[2], "base64");
      if (data.length > maxBytes) throw new Error(`媒體過大（上限 ${config.maxBodyMb}MB）`);
      return { data, name: filename?.trim() || `upload.${extFor(kind, dataUrl[1])}` };
    }
    // http(s) 由 Bot API 直接抓取，不經本地；其餘視為本地路徑。
    const safePath = resolveLocalMediaPath(source, config.uploadsPath, config.cachePath);
    let data: Buffer;
    try {
      data = readFileSync(safePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`檔案不存在：${safePath}（請先經 /settings/upload 上傳）`);
      }
      throw error;
    }
    if (data.length > maxBytes) throw new Error(`媒體過大（上限 ${config.maxBodyMb}MB）`);
    return { data, name: filename?.trim() || basename(safePath) };
  }

  private async sendMedia(
    chatId: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    const method = kind === "image" ? "sendPhoto" : kind === "video" ? "sendVideo" : kind === "audio" ? "sendAudio" : "sendDocument";
    const field = kind === "image" ? "photo" : kind === "video" ? "video" : kind === "audio" ? "audio" : "document";
    if (/^https?:\/\//i.test(source)) {
      await this.api(method, { chat_id: chatId, [field]: source });
      logger.info("已傳送媒體（Telegram URL）", { to: chatId, kind });
      return;
    }
    const { data, name } = await this.loadMediaBytes(source, kind, filename);
    const form = new FormData();
    form.append("chat_id", chatId);
    const ext = extname(name).toLowerCase();
    const mime = kind === "image" ? `image/${ext === ".png" ? "png" : ext === ".gif" ? "gif" : "jpeg"}` : "application/octet-stream";
    form.append(field, new Blob([data], { type: mime }), name);
    await this.api(method, undefined, form);
    logger.info("已傳送媒體（Telegram 上傳）", { to: chatId, kind, file: name, bytes: data.length });
  }

  private async sendSticker(chatId: string, sticker: StickerInput): Promise<void> {
    // Telegram 貼圖需 file_id，無法從 LINE packageId/stickerId 對應，降級為文字說明。
    logger.info("貼圖降級為文字（Telegram）", { to: chatId });
    await this.rawSendText(chatId, `（LINE 貼圖，Telegram 無法顯示：${sticker.packageId}/${sticker.stickerId}）`);
  }

  private async sendLocation(chatId: string, location: LocationInput): Promise<void> {
    if (location.title) {
      await this.api("sendVenue", {
        chat_id: chatId,
        latitude: location.latitude,
        longitude: location.longitude,
        title: location.title,
        address: location.address || location.title,
      });
    } else {
      await this.api("sendLocation", {
        chat_id: chatId,
        latitude: location.latitude,
        longitude: location.longitude,
      });
    }
    logger.info("已傳送位置（Telegram）", { to: chatId, title: location.title });
  }

  private async sendFlex(chatId: string, flex: FlexInput): Promise<void> {
    // Telegram 無 Flex 對應，降級為 altText。
    logger.info("Flex 降級為文字（Telegram）", { to: chatId });
    await this.rawSendText(chatId, flex.altText || "（Flex 卡片僅支援 LINE）");
  }

  schedule(inputs: SendInput[], runAt: number, repeat?: string): ScheduledJobView {
    return this.scheduler.add(inputs, runAt, repeat);
  }

  updateScheduled(
    id: string,
    patch: { runAt?: number; repeat?: string | null },
  ): ScheduledJobView | null {
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

  stopListening(): void {
    logger.info("Telegram 使用 webhook 接收，無需停止監聽");
  }

  stopQueue(): void {
    this.queue.stop();
    this.scheduler.stop();
  }
}
