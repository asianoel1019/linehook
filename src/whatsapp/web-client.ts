import { readFileSync } from "node:fs";
import { basename } from "node:path";
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

/*
 * Baileys 是 ESM 且帶原生/WASM 相依，若在頂層 import，某些主機（缺原生模組的部署環境）
 * 會在啟動載入階段就丟錯，導致整個服務起不來（nginx 502）。
 * 因此改為「啟用 Web 模式時才動態載入」，LINE / Telegram 不受影響。
 */
type WASocket = {
  ev: {
    on(event: "creds.update", cb: (update: unknown) => void): void;
    on(event: "connection.update", cb: (update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => void): void;
    on(event: "messages.upsert", cb: (event: { type: string; messages: WAMessage[] }) => void): void;
  };
  user?: { id?: string; name?: string } | null;
  sendMessage(jid: string, content: unknown): Promise<unknown>;
  end(error?: Error): void;
};
type WAMessage = {
  key?: { remoteJid?: string | null; fromMe?: boolean | null; id?: string };
  pushName?: string | null;
  message?: Record<string, unknown> | null;
};

interface BaileysModule {
  makeWASocket: (opts: Record<string, unknown>) => WASocket;
  useMultiFileAuthState: (path: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  DisconnectReason: { loggedOut?: number };
  fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>;
}

let baileysPromise: Promise<BaileysModule> | null = null;

function loadBaileys(): Promise<BaileysModule> {
  if (!baileysPromise) {
    baileysPromise = import("@whiskeysockets/baileys") as unknown as Promise<BaileysModule>;
  }
  return baileysPromise;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 電話號碼（E.164，不含 +）轉 WhatsApp JID；已含 @ 則原樣。 */
export function toWaJid(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/** 從 Baileys 的訊息內容取出可用的文字。 */
export function extractWaText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return "";
  const m = message as {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string };
    buttonsResponseMessage?: { selectedDisplayText?: string };
    listResponseMessage?: { title?: string };
    templateButtonReplyMessage?: { selectedDisplayText?: string };
  };
  return (
    m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? m.buttonsResponseMessage?.selectedDisplayText
    ?? m.templateButtonReplyMessage?.selectedDisplayText
    ?? m.listResponseMessage?.title
    ?? ""
  ).trim();
}

export class WhatsAppWebService implements IMessagingService {
  readonly platform = "whatsapp" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  private sock: WASocket | null = null;
  private starting = false;
  private loggedIn = false;
  private qrDataUrl = "";
  private meId = "";
  private loginState = "未登入";

  constructor() {
    this.queue = new SendQueue(() => ({
      maxRetries: config.send.maxRetries,
      retryBaseMs: config.send.retryBaseMs,
      minIntervalMs: config.send.minIntervalMs,
      isPermanent: (error) => {
        if (error instanceof TargetNotFoundError || error instanceof NotLoggedInError) return true;
        const message = error instanceof Error ? error.message : String(error);
        if (/429|rate|頻繁|timeout|逾時|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|retry after/i.test(message)) {
          return false;
        }
        return /40[0-4]|422|invalid|wrong|驗證失敗|參數錯誤|不支援|格式錯誤|找不到|not.*registered|no such/i.test(message);
      },
    }));
    this.scheduler = new SendScheduler(
      (inputs) => this.sendAdvanced(inputs),
      (job) => dispatchSkillTask(job, this.dispatchDeps()),
      this.schedulesPath(),
    );
  }

  private schedulesPath(): string {
    const base = config.schedulesPath;
    const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
    const dir = slash >= 0 ? base.slice(0, slash) : ".";
    const file = slash >= 0 ? base.slice(slash + 1) : base;
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    const ext = dot >= 0 ? file.slice(dot) : ".json";
    return `${dir}/${stem}-whatsapp-web${ext}`;
  }

  async init(): Promise<void> {
    if (!config.whatsapp.enabled || config.whatsapp.mode !== "web") {
      logger.info("WhatsApp(Web) 未啟用，略過初始化");
      return;
    }
    if (this.starting || this.sock) return;
    this.starting = true;
    try {
      await this.connect();
    } catch (error) {
      logger.error("WhatsApp(Web) 初始化失敗", { error: String(error) });
    } finally {
      this.starting = false;
    }
  }

  private async connect(): Promise<void> {
    this.loginState = "登入中";
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = await loadBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.webAuthPath);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      // 無網路時用套件內建版本。
    }
    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: ["IM Webhook", "Chrome", "1.0.0"],
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qrDataUrl = qr;
        this.loginState = "待驗證";
        setState({ qrUrl: qr, status: "待驗證", lastError: undefined });
        logger.info("WhatsApp(Web) 需要掃描 QR 登入");
      }
      if (connection === "open") {
        this.loggedIn = true;
        this.meId = sock.user?.id ?? "";
        this.qrDataUrl = "";
        this.loginState = "已登入";
        setState({
          status: "已登入",
          qrUrl: undefined,
          profileName: sock.user?.name ?? sock.user?.id ?? "",
          myMid: this.meId,
          lastLoginAt: new Date().toISOString(),
        });
        logger.info("WhatsApp(Web) 已登入", { id: this.meId });
      }
      if (connection === "close") {
        this.loggedIn = false;
        this.sock = null;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.loginState = "需人工";
          setState({ status: "需人工", qrUrl: undefined, lastError: "WhatsApp 已登出，請刪除 session 後重新掃描" });
          logger.warn("WhatsApp(Web) 已登出，需重新登入（刪除 webAuthPath）");
        } else {
          this.loginState = "登入中";
          setState({ status: "登入中" });
          logger.warn("WhatsApp(Web) 連線中斷，5 秒後重連", { code });
          setTimeout(() => { void this.connect().catch((e) => logger.error("WhatsApp(Web) 重連失敗", { error: String(e) })); }, 5000);
        }
      }
    });
    sock.ev.on("messages.upsert", (event: { type: string; messages: WAMessage[] }) => {
      if (event.type !== "notify") return;
      for (const msg of event.messages) {
        void this.handleWebMessage(msg);
      }
    });
  }

  private async handleWebMessage(msg: WAMessage): Promise<void> {
    try {
      if (!msg.key || msg.key.fromMe) return;
      const jid = msg.key.remoteJid ?? "";
      if (!jid) return;
      if (!jid.includes("@")) return;
      const text = extractWaText(msg.message as Record<string, unknown> | null | undefined);
      if (!text) return;
      const fromId = jid.split("@")[0];
      const incoming: IncomingMessage = {
        chat: jid,
        fromId,
        fromName: msg.pushName ?? fromId,
        chatName: jid.endsWith("@g.us") ? jid.split("@")[0] : "",
        text,
        messageId: msg.key.id ?? undefined,
      };
      recordMessage({
        time: new Date().toISOString(),
        fromMid: fromId,
        fromName: incoming.fromName,
        chatMid: jid,
        chatType: "whatsapp",
        text,
      });
      await dispatchIncoming(incoming, this.dispatchDeps());
    } catch (error) {
      logger.error("WhatsApp(Web) 處理訊息失敗", { error: String(error) });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!config.whatsapp.enabled || config.whatsapp.mode !== "web") return false;
    return this.loggedIn && this.sock !== null;
  }

  async recover(): Promise<boolean> {
    if (this.sock) return true;
    try {
      await this.connect();
      return true;
    } catch (error) {
      logger.error("WhatsApp(Web) 重連失敗", { error: String(error) });
      return false;
    }
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, phone] of Object.entries(config.whatsapp.targets)) {
      const jid = toWaJid(phone);
      nameToChat.set(name, jid);
      if (!chatToName.has(jid)) chatToName.set(jid, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("WhatsApp(Web) 目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    if (trimmed.includes("@")) return trimmed;
    const digits = trimmed.replace(/[^\d]/g, "");
    if (/^\d{6,15}$/.test(digits)) return toWaJid(digits);
    return null;
  }

  /** 目前 QR（Baileys 給的是原始字串，前端用 QR 產生器渲染）。 */
  getQr(): string {
    return this.qrDataUrl;
  }

  loginStatus(): string {
    return this.loginState;
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

  private async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.loggedIn) throw new NotLoggedInError("WhatsApp");
    await this.sock.sendMessage(jid, { text });
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const jid = this.resolveTarget(to);
    if (!jid) throw new TargetNotFoundError(to);
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.sendText(jid, part);
      recordSend({ time: new Date().toISOString(), to, type: "text", ok: true, platform: "whatsapp" });
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(jid) ?? jid });
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
    const jid = this.resolveTarget(input.to);
    if (!jid) throw new TargetNotFoundError(input.to);

    if (input.image) await this.sendMedia(jid, input.image, "image", input.filename);
    if (input.video) await this.sendMedia(jid, input.video, "video", input.filename);
    if (input.audio) await this.sendMedia(jid, input.audio, "audio", input.filename);
    if (input.file) await this.sendMedia(jid, input.file, "file", input.filename);
    if (input.sticker) await this.sendSticker(jid, input.sticker);
    if (input.location) await this.sendLocation(jid, input.location);
    if (input.flex) await this.sendFlex(jid, input.flex);
    if (input.text) await this.rawSendText(jid, input.text);

    recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: true, platform: "whatsapp" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(jid) ?? jid });
  }

  private async rawSendText(jid: string, text: string): Promise<void> {
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      await this.sendText(jid, part);
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const jid = this.resolveTarget(chat) ?? chat;
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 4096));
    for (const part of parts) {
      try {
        await this.sendText(jid, part);
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "whatsapp" });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "whatsapp" });
        throw error;
      }
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private loadMediaBytes(source: string): { data: Buffer; name: string } {
    const maxBytes = Math.max(1, config.maxBodyMb) * 1024 * 1024;
    const dataUrl = /^data:([^;,]*);base64,(.*)$/is.exec(source);
    if (dataUrl) {
      const data = Buffer.from(dataUrl[2], "base64");
      if (data.length > maxBytes) throw new Error(`媒體過大（上限 ${config.maxBodyMb}MB）`);
      return { data, name: "upload.bin" };
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
    return { data, name: basename(safePath) };
  }

  private async sendMedia(
    jid: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    if (!this.sock || !this.loggedIn) throw new NotLoggedInError("WhatsApp");
    // 公開 URL：Baileys 可直接帶 URL。
    if (/^https?:\/\//i.test(source)) {
      const payload = this.mediaPayload(kind, { url: source }, filename);
      await this.sock.sendMessage(jid, payload);
      logger.info("已傳送媒體（WhatsApp Web URL）", { to: jid, kind });
      return;
    }
    const { data } = this.loadMediaBytes(source);
    const payload = this.mediaPayload(kind, data, filename);
    await this.sock.sendMessage(jid, payload);
    logger.info("已傳送媒體（WhatsApp Web 上傳）", { to: jid, kind, bytes: data.length });
  }

  private mediaPayload(
    kind: "image" | "video" | "audio" | "file",
    content: Buffer | { url: string },
    filename?: string,
  ): Record<string, unknown> {
    if (kind === "image") return { image: content, caption: filename || undefined };
    if (kind === "video") return { video: content, caption: filename || undefined };
    if (kind === "audio") return { audio: content, mimetype: "audio/mp4" };
    return { document: content, fileName: filename || "file", mimetype: "application/octet-stream" };
  }

  private async sendSticker(jid: string, sticker: StickerInput): Promise<void> {
    logger.info("貼圖降級為文字（WhatsApp Web）", { to: jid });
    await this.rawSendText(jid, `（貼圖，WhatsApp 無法顯示：${sticker.packageId}/${sticker.stickerId}）`);
  }

  private async sendLocation(jid: string, location: LocationInput): Promise<void> {
    if (!this.sock || !this.loggedIn) throw new NotLoggedInError("WhatsApp");
    await this.sock.sendMessage(jid, {
      location: { degreesLatitude: location.latitude, degreesLongitude: location.longitude, name: location.title || undefined, address: location.address || undefined },
    });
    logger.info("已傳送位置（WhatsApp Web）", { to: jid, title: location.title });
  }

  private async sendFlex(jid: string, flex: FlexInput): Promise<void> {
    logger.info("Flex 降級為文字（WhatsApp Web）", { to: jid });
    await this.rawSendText(jid, flex.altText || "（Flex 卡片僅支援 LINE）");
  }

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

  stopListening(): void {
    try {
      this.sock?.end(undefined);
    } catch {
      // ignore
    }
    this.sock = null;
    this.loggedIn = false;
  }

  stopQueue(): void {
    this.stopListening();
    this.queue.stop();
    this.scheduler.stop();
  }
}
