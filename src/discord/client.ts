import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import { writeDeadLetter } from "../deadletter.js";
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

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** Discord 單則訊息上限 2000 字元。 */
const CONTENT_LIMIT = 2000;
/** GUILDS(1) | GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768) */
const INTENTS = 1 + 512 + 4096 + 32768;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DiscordMessageEvent {
  d?: {
    id?: string;
    channel_id?: string;
    author?: { id?: string; username?: string; bot?: boolean };
    content?: string;
    member?: { nick?: string };
  };
}

interface GatewayFrame {
  op?: number;
  t?: string;
  d?: {
    heartbeat_interval?: number;
    user?: { id?: string; username?: string };
    message?: string;
  };
}

/**
 * 把 Discord MESSAGE_CREATE 事件正規化成平台無關訊息；機器人訊息或空內容回 null。
 * messageId 供共用去重（A1）使用。
 */
export function normalizeDiscordMessage(evt: DiscordMessageEvent, selfId: string): IncomingMessage | null {
  const d = evt?.d;
  if (!d || !d.channel_id || !d.author) return null;
  if (d.author.bot) return null;
  if (selfId && d.author.id === selfId) return null;
  const text = (d.content ?? "").trim();
  if (!text) return null;
  const fromId = d.author.id ?? "";
  const fromName = d.member?.nick || d.author.username || fromId;
  return {
    chat: d.channel_id,
    fromId,
    fromName,
    chatName: "",
    text,
    messageId: d.id,
  };
}

type LoginState = "未登入" | "連線中" | "已登入" | "需人工";

export class DiscordService implements IMessagingService {
  readonly platform = "discord" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private selfId = "";
  private loginState: LoginState = "未登入";

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
        return /40[0-4]|422|Missing Access|Unknown Channel|unauthorized|invalid|not found/i.test(message);
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
    return join(dir, `${stem}-discord${ext}`);
  }

  private get token(): string {
    return config.discord.botToken.trim();
  }

  // ---------- Gateway（收訊；Node 內建 WebSocket） ----------

  async init(): Promise<void> {
    if (!config.discord.enabled) {
      logger.info("Discord 未啟用，略過初始化");
      return;
    }
    if (!this.token) {
      logger.warn("Discord 已啟用但未設定 botToken，略過");
      return;
    }
    await this.refreshContacts();
    this.stopping = false;
    this.connect();
  }

  private connect(): void {
    this.cleanupSocket();
    this.loginState = "連線中";
    let ws: WebSocket;
    try {
      ws = new WebSocket(GATEWAY_URL);
    } catch (error) {
      this.loginState = "需人工";
      logger.error("Discord Gateway 連線失敗", { error: String(error) });
      this.scheduleReconnect(10_000);
      return;
    }
    this.socket = ws;

    ws.addEventListener("message", (event) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onFrame(ws, frame);
    });
    ws.addEventListener("close", () => {
      this.cleanupSocket();
      if (this.stopping) return;
      logger.warn("Discord Gateway 斷線，稍後重連");
      this.loginState = "連線中";
      this.scheduleReconnect(5_000);
    });
    ws.addEventListener("error", (event) => {
      logger.error("Discord Gateway 錯誤", { error: (event as { message?: string }).message ?? "unknown" });
    });
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private onFrame(ws: WebSocket, frame: GatewayFrame): void {
    switch (frame.op) {
      case 10: {
        const interval = frame.d?.heartbeat_interval ?? 40000;
        const jitter = Math.floor(interval * Math.random());
        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
        }, interval);
        this.heartbeat.unref?.();
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: this.token,
                  intents: INTENTS,
                  properties: { os: "linux", browser: "im-webhook", device: "im-webhook" },
                },
              }),
            );
          }
        }, jitter).unref?.();
        break;
      }
      case 0:
        this.onDispatch(frame.t ?? "", frame.d);
        break;
      case 1:
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
        break;
      default:
        break;
    }
  }

  private onDispatch(t: string, d: GatewayFrame["d"]): void {
    if (t === "READY") {
      this.selfId = d?.user?.id ?? "";
      this.loginState = "已登入";
      logger.info("Discord Bot 已連線", { id: this.selfId });
      return;
    }
    if (t === "MESSAGE_CREATE") void this.handleMessage(d as DiscordMessageEvent["d"]);
  }

  private async handleMessage(raw: DiscordMessageEvent["d"]): Promise<void> {
    const msg = normalizeDiscordMessage({ d: raw }, this.selfId);
    if (!msg) return;
    recordMessage({
      time: new Date().toISOString(),
      fromMid: msg.fromId,
      fromName: msg.fromName,
      chatMid: msg.chat,
      chatType: "discord",
      text: msg.text,
    });
    await dispatchIncoming(msg, this.dispatchDeps());
  }

  private cleanupSocket(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  stopListening(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }

  async healthCheck(): Promise<boolean> {
    if (!config.discord.enabled) return false;
    return this.loginState === "已登入";
  }

  async recover(): Promise<boolean> {
    if (this.stopping) return false;
    this.connect();
    return true;
  }

  loginStatus(): string {
    return this.loginState;
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, id] of Object.entries(config.discord.targets)) {
      nameToChat.set(name, id);
      if (!chatToName.has(id)) chatToName.set(id, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("Discord 目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    if (/^\d{17,20}$/.test(trimmed)) return trimmed;
    return null;
  }

  // ---------- 發送（REST） ----------

  private async post(path: string, body?: unknown, form?: FormData): Promise<void> {
    if (!this.token) throw new NotLoggedInError("Discord");
    let res: Response;
    try {
      if (form) {
        res = await fetchWithLimits(`${API_BASE}${path}`, {
          method: "POST",
          headers: { Authorization: `Bot ${this.token}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        res = await fetchWithLimits(`${API_BASE}${path}`, {
          method: "POST",
          headers: { Authorization: `Bot ${this.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(30_000),
        });
      }
    } catch (error) {
      throw new Error(`Discord API 連線失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord API 發送失敗（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`);
    }
  }

  private async sendText(channelId: string, text: string): Promise<void> {
    const parts = chunkReplyText(text, CONTENT_LIMIT);
    for (const part of parts) {
      await this.post(`/channels/${channelId}/messages`, { content: part });
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const id = this.resolveTarget(to);
    if (!id) throw new TargetNotFoundError(to);
    await this.sendText(id, text);
    recordSend({ time: new Date().toISOString(), to, type: "text", ok: true, platform: "discord" });
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
        recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: false, platform: "discord" });
        writeDeadLetter({
          platform: "discord",
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

    recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: true, platform: "discord" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async rawSendText(channelId: string, text: string): Promise<void> {
    await this.sendText(channelId, text);
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const id = this.resolveTarget(chat) ?? chat;
    try {
      await this.sendText(id, text);
      recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "discord" });
    } catch (error) {
      recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "discord" });
      throw error;
    }
  }

  private async sendMedia(
    channelId: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    if (/^https?:\/\//i.test(source)) {
      if (kind === "image") {
        await this.post(`/channels/${channelId}/messages`, { embeds: [{ image: { url: source } }] });
      } else if (kind === "video") {
        await this.post(`/channels/${channelId}/messages`, { content: source });
      } else {
        await this.post(`/channels/${channelId}/messages`, { embeds: [{ url: source, title: filename ?? source }] });
      }
      logger.info("已傳送媒體（Discord URL）", { to: channelId, kind });
      return;
    }
    const maxBytes = Math.max(1, config.maxBodyMb) * 1024 * 1024;
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
    const name = filename || basename(safePath);
    const form = new FormData();
    form.append("content", kind === "image" ? "（圖片）" : `（${name}）`);
    form.append("files[0]", new Blob([new Uint8Array(data)]), name);
    await this.post(`/channels/${channelId}/messages`, undefined, form);
    logger.info("已傳送媒體（Discord 上傳）", { to: channelId, kind, file: name, bytes: data.length });
  }

  private async sendSticker(channelId: string, sticker: StickerInput): Promise<void> {
    logger.info("貼圖降級為文字（Discord）", { to: channelId });
    await this.sendText(channelId, `（貼圖，Discord 無法顯示：${sticker.packageId}/${sticker.stickerId}）`);
  }

  private async sendLocation(channelId: string, location: LocationInput): Promise<void> {
    const title = location.title || "位置";
    await this.post(`/channels/${channelId}/messages`, {
      content: `${title}${location.address ? `\n${location.address}` : ""}`,
      embeds: [{ url: `https://www.google.com/maps?q=${location.latitude},${location.longitude}`, title }],
    });
    logger.info("已傳送位置（Discord）", { to: channelId, title });
  }

  private async sendFlex(channelId: string, flex: FlexInput): Promise<void> {
    const texts: string[] = [];
    const contents = flex.contents as { body?: { contents?: Array<{ type?: string; text?: string }> } };
    for (const node of contents?.body?.contents ?? []) {
      if (node.type === "text" && node.text) texts.push(node.text);
    }
    await this.post(`/channels/${channelId}/messages`, {
      content: texts.length === 0 ? flex.altText : "",
      embeds: [{ title: flex.altText || "Flex", description: texts.join("\n") || undefined }],
    });
    logger.info("已傳送 Embed（Discord，Flex 降級）", { to: channelId });
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

  enqueueText(to: string, text: string): Promise<void> {
    return this.queue.enqueue(() => this.rawSend(to, text));
  }

  stopQueue(): void {
    this.stopListening();
    this.queue.stop();
    this.scheduler.stop();
  }

  private dispatchDeps(): DispatchDeps {
    return {
      platform: "discord",
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
}
