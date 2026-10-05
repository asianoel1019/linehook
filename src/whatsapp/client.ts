import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeFor(kind: string, name: string): string {
  const ext = extname(name).toLowerCase();
  if (kind === "image") {
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "image/jpeg";
  }
  if (kind === "video") return ext === ".3gp" ? "video/3gpp" : "video/mp4";
  if (kind === "audio") {
    if (ext === ".ogg") return "audio/ogg";
    if (ext === ".amr") return "audio/amr";
    if (ext === ".aac") return "audio/aac";
    return "audio/mpeg";
  }
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

/** WhatsApp Cloud API webhook 的型別（僅取用到的欄位）。 */
export interface WaWebhook {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messaging_product?: string;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          contacts?: unknown;
        }>;
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
      };
    }>;
  }>;
}

/**
 * 把 WhatsApp Cloud API webhook 正規化成平台無關訊息。
 * 一個 webhook 可能含多筆 messages，這裡一次只回一筆（由 handleIncoming 逐筆處理）。
 */
export function normalizeWhatsAppWebhook(payload: WaWebhook): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const meta = value?.metadata;
      const contact = value?.contacts?.[0];
      for (const msg of value?.messages ?? []) {
        if (!msg.from) continue;
        const text = (msg.text?.body ?? msg.button?.text ?? "").trim();
        if (!text) continue;
        const fromId = msg.from;
        const fromName = contact?.profile?.name?.trim() || fromId;
        out.push({
          chat: fromId,
          fromId,
          fromName,
          chatName: meta?.display_phone_number ?? "",
          text,
          messageId: msg.id,
        });
      }
    }
  }
  return out;
}

/** 驗證 Meta webhook 的 X-Hub-Signature-256（sha256=HMAC-SHA256(appSecret, rawBody)）。 */
export function verifyWhatsAppSignature(rawBody: Buffer, header: string, appSecret: string): boolean {
  if (!appSecret) return true;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const bufA = Buffer.from(provided, "utf8");
  const bufB = Buffer.from(expected, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export class WhatsAppService implements IMessagingService {
  readonly platform = "whatsapp" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  private busy = false;
  private displayNumber = "";

  constructor() {
    this.queue = new SendQueue(() => ({
      maxRetries: config.send.maxRetries,
      retryBaseMs: config.send.retryBaseMs,
      minIntervalMs: config.send.minIntervalMs,
      isPermanent: (error) => {
        if (error instanceof TargetNotFoundError || error instanceof NotLoggedInError) return true;
        const message = error instanceof Error ? error.message : String(error);
        // 限流/逾時/連線錯誤可重試。
        if (/429|rate|頻繁|timeout|逾時|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|retry after/i.test(message)) {
          return false;
        }
        // 24 小時視窗外的 free-form 訊息重試也不會過，視為永久錯誤。
        if (/24\s*(hour|小時)|re-?engagement|outside.*window|message.*window|131047/i.test(message)) {
          return true;
        }
        return /40[0-4]|422|unauthorized|invalid|wrong|驗證失敗|參數錯誤|不支援|格式錯誤|找不到/i.test(message);
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
    return join(dir, `${stem}-whatsapp${ext}`);
  }

  private get token(): string {
    return config.whatsapp.accessToken.trim();
  }

  private get phoneId(): string {
    return config.whatsapp.phoneNumberId.trim();
  }

  private baseUrl(): string {
    return `https://graph.facebook.com/${config.whatsapp.apiVersion}/${this.phoneId}/`;
  }

  private async api<T = unknown>(method: string, body?: Record<string, unknown>, form?: FormData): Promise<T> {
    if (!this.token || !this.phoneId) throw new NotLoggedInError("WhatsApp");
    let res: Response;
    try {
      if (form) {
        res = await fetchWithLimits(this.baseUrl() + method, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        res = await fetch(this.baseUrl() + method, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(20_000),
        });
      }
    } catch (error) {
      throw new Error(`WhatsApp API 連線失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text();
    let data: { error?: { message?: string; code?: number } };
    try {
      data = text ? (JSON.parse(text) as { error?: { message?: string; code?: number } }) : {};
    } catch {
      throw new Error(`WhatsApp API 回應解析失敗（HTTP ${res.status}）`);
    }
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || `WhatsApp API 錯誤（HTTP ${res.status}）`);
    }
    return data as T;
  }

  async init(): Promise<void> {
    if (!config.whatsapp.enabled || !this.token || !this.phoneId) {
      logger.info("WhatsApp 未啟用（未設定 accessToken / phoneNumberId），略過初始化");
      return;
    }
    try {
      await this.refreshContacts();
      logger.info("WhatsApp 已啟用", { phoneNumberId: this.phoneId, apiVersion: config.whatsapp.apiVersion });
      if (!config.whatsapp.appSecret.trim()) {
        logger.warn("WhatsApp 未設定 appSecret，/wa/webhook 將不驗證 X-Hub-Signature-256（不建議）");
      }
    } catch (error) {
      logger.error("WhatsApp 初始化失敗", { error: String(error) });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!config.whatsapp.enabled || !this.token || !this.phoneId) return false;
    try {
      // 以 phone number id 查詢基本資訊，驗證 token 有效。
      const res = await fetch(
        `https://graph.facebook.com/${config.whatsapp.apiVersion}/${this.phoneId}?fields=display_phone_number`,
        { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) },
      );
      const data = (await res.json()) as { display_phone_number?: string; error?: { message?: string } };
      if (!res.ok || data.error) return false;
      if (data.display_phone_number) this.displayNumber = data.display_phone_number;
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
      return await this.healthCheck();
    } catch (error) {
      logger.error("WhatsApp 重連失敗", { error: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, id] of Object.entries(config.whatsapp.targets)) {
      nameToChat.set(name, id);
      if (!chatToName.has(id)) chatToName.set(id, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("WhatsApp 目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  /** WhatsApp 目標為電話號碼（E.164，通常不含 +）；同名或直接給號碼皆可。 */
  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    const digits = trimmed.replace(/[^\d]/g, "");
    if (/^\d{6,15}$/.test(digits)) return digits;
    return null;
  }

  async handleIncoming(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const messages = normalizeWhatsAppWebhook(payload as WaWebhook);
    for (const msg of messages) {
      recordMessage({
        time: new Date().toISOString(),
        fromMid: msg.fromId,
        fromName: msg.fromName,
        chatMid: msg.chat,
        chatType: "whatsapp",
        text: msg.text,
      });
      await dispatchIncoming(msg, this.dispatchDeps());
    }
  }

  private dispatchDeps(): DispatchDeps {
    return {
      platform: "whatsapp",
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

  private async sendTextMessage(to: string, text: string): Promise<void> {
    await this.api("messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    });
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const id = this.resolveTarget(to);
    if (!id) throw new TargetNotFoundError(to);
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.sendTextMessage(id, part);
      recordSend({ time: new Date().toISOString(), to, type: "text", ok: true, platform: "whatsapp" });
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
        recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: false, platform: "whatsapp" });
        writeDeadLetter({
          platform: "whatsapp",
          kind: "send",
          to: [input.to],
          payload: [input],
          summary: this.inputType(input),
          error: error instanceof Error ? error.message : String(error),
        });
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

    recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: true, platform: "whatsapp" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async rawSendText(to: string, text: string): Promise<void> {
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.sendTextMessage(to, part);
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const id = this.resolveTarget(chat) ?? chat;
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      try {
        await this.sendTextMessage(id, part);
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "whatsapp" });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "whatsapp" });
        // 24 小時視窗外：明確提示，方便使用者改用模板。
        const message = error instanceof Error ? error.message : String(error);
        if (/24\s*(hour|小時)|re-?engagement|outside.*window|message.*window|131047/i.test(message)) {
          logger.warn("WhatsApp 主動訊息遭拒（可能超過 24 小時視窗，需改用預審模板）", { to: chat });
        }
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
      const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "bin";
      return { data, name: filename?.trim() || `upload.${ext}` };
    }
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

  /** 上傳媒體取得 media id（WhatsApp 需先上傳或用公開 URL）。 */
  private async uploadMedia(data: Buffer, mime: string, name: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([data], { type: mime }), name);
    const result = await this.api<{ id?: string }>("media", undefined, form);
    if (!result.id) throw new Error("WhatsApp 媒體上傳未取得 id");
    return result.id;
  }

  private async sendMedia(
    to: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    const waType = kind === "file" ? "document" : kind;
    // 公開 URL 直接用 link 傳送（WhatsApp 會自行抓取）。
    if (/^https?:\/\//i.test(source)) {
      const payload: Record<string, unknown> = { messaging_product: "whatsapp", to, type: waType };
      payload[waType] = { link: source };
      if (kind === "file") (payload[waType] as Record<string, unknown>).filename = filename ?? "file";
      await this.api("messages", payload);
      logger.info("已傳送媒體（WhatsApp URL）", { to, kind });
      return;
    }
    const { data, name } = await this.loadMediaBytes(source, kind, filename);
    const mediaId = await this.uploadMedia(data, mimeFor(kind, name), name);
    const payload: Record<string, unknown> = { messaging_product: "whatsapp", to, type: waType };
    payload[waType] = { id: mediaId };
    if (kind === "file") (payload[waType] as Record<string, unknown>).filename = name;
    await this.api("messages", payload);
    logger.info("已傳送媒體（WhatsApp 上傳）", { to, kind, file: name, bytes: data.length });
  }

  private async sendSticker(to: string, sticker: StickerInput): Promise<void> {
    // WhatsApp 無貼圖對應，降級為文字說明。
    logger.info("貼圖降級為文字（WhatsApp）", { to });
    await this.rawSendText(to, `（貼圖，WhatsApp 無法顯示：${sticker.packageId}/${sticker.stickerId}）`);
  }

  private async sendLocation(to: string, location: LocationInput): Promise<void> {
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to,
      type: "location",
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.title || undefined,
        address: location.address || undefined,
      },
    };
    await this.api("messages", payload);
    logger.info("已傳送位置（WhatsApp）", { to, title: location.title });
  }

  private async sendFlex(to: string, flex: FlexInput): Promise<void> {
    // WhatsApp 無 Flex 對應，降級為 altText。
    logger.info("Flex 降級為文字（WhatsApp）", { to });
    await this.rawSendText(to, flex.altText || "（Flex 卡片僅支援 LINE）");
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

  /** Cloud API：設定 token / phoneNumberId 後視為已連線。 */
  loginStatus(): string {
    return this.token && this.phoneId ? "已登入" : "未設定";
  }

  getDisplayNumber(): string {
    return this.displayNumber;
  }

  stopListening(): void {
    logger.info("WhatsApp 使用 webhook 接收，無需停止監聽");
  }

  stopQueue(): void {
    this.queue.stop();
    this.scheduler.stop();
  }
}
