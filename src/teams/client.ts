import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
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
import { fetchWithLimits, fetchJson } from "../net.js";
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

/** Bot Connector 進站 activity（僅取用到的欄位）。 */
export interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string; name?: string; tenantId?: string; conversationType?: string };
  channelId?: string;
  serviceUrl?: string;
  recipient?: { id?: string; name?: string };
  membersAdded?: Array<{ id?: string; name?: string }>;
}

/**
 * 把 Teams activity 正規化成平台無關訊息；非文字或機器人自己回 null。
 * 注意：Teams 會把 Bot 自己的回覆也回傳（from.id === recipient.id）→ 需過濾。
 */
export function normalizeTeamsActivity(activity: TeamsActivity): IncomingMessage | null {
  if (!activity || activity.type !== "message") return null;
  const text = (activity.text ?? "").trim();
  if (!text) return null;
  const fromId = activity.from?.id ?? "";
  const selfId = activity.recipient?.id ?? "";
  if (fromId && selfId && fromId === selfId) return null; // 自己的訊息
  const conversationId = activity.conversation?.id ?? "";
  if (!conversationId) return null;
  return {
    chat: conversationId,
    fromId,
    fromName: activity.from?.name ?? fromId,
    chatName: activity.conversation?.name ?? "",
    text,
  };
}

/** Adaptive Card 由 Flex 容器轉譯（Teams 支援，非降級）。 */
export function flexToAdaptiveCard(flex: FlexInput): Record<string, unknown> {
  const body: unknown[] = [];
  const contents = flex.contents as { body?: { contents?: Array<{ type?: string; text?: string }> } };
  const flexBody = contents?.body?.contents;
  if (Array.isArray(flexBody)) {
    for (const node of flexBody) {
      if (node?.type === "text" && node.text) body.push({ type: "TextBlock", text: node.text, wrap: true });
    }
  }
  if (body.length === 0) body.push({ type: "TextBlock", text: flex.altText || " ", wrap: true });
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
}

/* ------------------------- Bot Connector JWT 驗證 ------------------------- */

interface Jwk { kid?: string; n?: string; e?: string; kty?: string; }
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

export async function fetchBotFrameworkJwks(force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.fetchedAt < 24 * 60 * 60 * 1000) return jwksCache.keys;
  const meta = await fetchJson<{ jwks_uri?: string }>("https://login.botframework.com/v1/.well-known/openidconfiguration");
  const jwksUri = meta.jwks_uri ?? "https://login.botframework.com/v1/.well-known/keys";
  const jwks = await fetchJson<{ keys?: Jwk[] }>(jwksUri);
  jwksCache = { keys: jwks.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

/** 驗證 Bot Connector 的 Bearer JWT：簽章（RS256, JWKS）＋ audience＝App ID。 */
export async function verifyTeamsJwt(authHeader: string, appId: string): Promise<boolean> {
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "RS256") return false;
  if (payload.aud !== appId) return false;
  if (payload.exp && payload.exp * 1000 < Date.now()) return false;
  const keys = await fetchBotFrameworkJwks();
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk?.n || !jwk?.e) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" } as never);
    return cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  } catch {
    return false;
  }
}

/* ------------------------------- Service ------------------------------- */

export class TeamsService implements IMessagingService {
  readonly platform = "teams" as const;
  private readonly queue: SendQueue;
  private readonly scheduler: SendScheduler;
  private nameToChat = new Map<string, string>();
  private chatToName = new Map<string, string>();
  /** conversationId → serviceUrl（主動推播需知道服務端點）。 */
  private conversations = new Map<string, string>();
  private busy = false;
  private token = "";
  private tokenExpiresAt = 0;
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
    const base = config.schedulesPath;
    const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
    const dir = slash >= 0 ? base.slice(0, slash) : ".";
    const file = slash >= 0 ? base.slice(slash + 1) : base;
    const dot = file.lastIndexOf(".");
    const stem = dot >= 0 ? file.slice(0, dot) : file;
    const ext = dot >= 0 ? file.slice(dot) : ".json";
    return join(dir, `${stem}-teams${ext}`);
  }

  private get appId(): string {
    return config.teams.appId.trim();
  }

  private get appPassword(): string {
    return config.teams.appPassword.trim();
  }

  private configured(): boolean {
    return config.teams.enabled && Boolean(this.appId) && Boolean(this.appPassword);
  }

  /** 以 Entra client-credentials 取得 Bot Connector access token（快取）。 */
  private async getToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    if (!this.configured()) throw new NotLoggedInError("Teams");
    const tenant = config.teams.tenantId.trim() || "botframework.com";
    const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.appId,
      client_secret: this.appPassword,
      scope: "https://api.botframework.com/.default",
    });
    const res = await fetchWithLimits(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Teams 取 token 回應解析失敗（HTTP ${res.status}）`);
    }
    if (!res.ok || !data.access_token) {
      throw new Error(`Teams 取 token 失敗：${data.error_description || data.error || `HTTP ${res.status}`}`);
    }
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  private serviceUrlFor(conversationId: string): string {
    return this.conversations.get(conversationId) || config.teams.serviceUrl.trim();
  }

  private async sendActivity(conversationId: string, activity: Record<string, unknown>): Promise<void> {
    const token = await this.getToken();
    const serviceUrl = this.serviceUrlFor(conversationId).replace(/\/$/, "");
    const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const res = await fetchWithLimits(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Teams 發送失敗（HTTP ${res.status}）：${t.slice(0, 200)}`);
    }
  }

  async init(): Promise<void> {
    if (!config.teams.enabled) {
      logger.info("Teams 未啟用，略過初始化");
      return;
    }
    if (!this.configured()) {
      logger.warn("Teams 已啟用但未設定 appId / appPassword，略過");
      return;
    }
    try {
      await this.refreshContacts();
      await this.getToken();
      this.loginState = "已登入";
      logger.info("Teams 已連線", { appId: this.appId, tenant: config.teams.tenantId || "(multi-tenant)" });
    } catch (error) {
      this.loginState = "需人工";
      logger.error("Teams 初始化失敗", { error: String(error) });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.configured()) return false;
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  async recover(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.token = "";
      await this.init();
      return this.loginState === "已登入";
    } catch (error) {
      logger.error("Teams 重連失敗", { error: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  refreshContacts(): Promise<void> {
    const nameToChat = new Map<string, string>();
    const chatToName = new Map<string, string>();
    for (const [name, id] of Object.entries(config.teams.targets)) {
      nameToChat.set(name, id);
      if (!chatToName.has(id)) chatToName.set(id, name);
    }
    this.nameToChat = nameToChat;
    this.chatToName = chatToName;
    logger.info("Teams 目標對照表已建立", { count: nameToChat.size });
    return Promise.resolve();
  }

  /** 目標可為名稱，或直接給 conversation id（例如 19:xxx@thread.v2 / a:xxx）。 */
  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToChat.get(trimmed);
    if (byName) return byName;
    if (this.chatToName.has(trimmed)) return trimmed;
    if (/^19:[A-Za-z0-9_-]+@thread/.test(trimmed)) return trimmed;
    if (/^a:[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
    return null;
  }

  /** 記錄收到的對話 serviceUrl，供之後主動推播使用。 */
  rememberConversation(activity: TeamsActivity): void {
    const id = activity.conversation?.id;
    const url = activity.serviceUrl;
    if (id && url) this.conversations.set(id, url);
  }

  async handleIncoming(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const activity = payload as TeamsActivity;
    this.rememberConversation(activity);
    const msg = normalizeTeamsActivity(activity);
    if (!msg) return;
    recordMessage({
      time: new Date().toISOString(),
      fromMid: msg.fromId,
      fromName: msg.fromName,
      chatMid: msg.chat,
      chatType: "teams",
      text: msg.text,
    });
    await dispatchIncoming(msg, this.dispatchDeps());
  }

  private dispatchDeps(): DispatchDeps {
    return {
      platform: "teams",
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

  private async sendText(conversationId: string, text: string): Promise<void> {
    await this.sendActivity(conversationId, { type: "message", text });
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const id = this.resolveTarget(to);
    if (!id) throw new TargetNotFoundError(to);
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 28000));
    for (const part of parts) {
      await this.sendText(id, part);
      recordSend({ time: new Date().toISOString(), to, type: "text", ok: true, platform: "teams" });
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
        recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: false, platform: "teams" });
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

    recordSend({ time: new Date().toISOString(), to: input.to, type: this.inputType(input), ok: true, platform: "teams" });
    setState({ lastSendAt: new Date().toISOString(), lastSendTo: this.chatToName.get(id) ?? id });
  }

  private async rawSendText(conversationId: string, text: string): Promise<void> {
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 28000));
    for (const part of parts) {
      await this.sendText(conversationId, part);
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const id = this.resolveTarget(chat) ?? chat;
    const parts = chunkReplyText(text, Math.min(config.replyMaxChars, 28000));
    for (const part of parts) {
      try {
        await this.sendText(id, part);
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "teams" });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "teams" });
        throw error;
      }
      if (parts.length > 1) await delay(config.send.minIntervalMs);
    }
  }

  /** Teams 媒體需先上傳附件到對話，再帶 contentUrl 送出；公開 URL 可直接用。 */
  private async sendMedia(
    conversationId: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    if (/^https?:\/\//i.test(source)) {
      const name = filename || source.split("/").pop() || "file";
      const contentType = kind === "image" ? "image/*" : kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "application/octet-stream";
      await this.sendActivity(conversationId, {
        type: "message",
        text: kind === "image" ? "（圖片）" : `（${name}）`,
        attachments: [{ contentType, contentUrl: source, name }],
      });
      logger.info("已傳送媒體（Teams URL）", { to: conversationId, kind });
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
    const token = await this.getToken();
    const serviceUrl = this.serviceUrlFor(conversationId).replace(/\/$/, "");
    const created = await fetchWithLimits(`${serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "file", name, originalName: name }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!created.ok) throw new Error(`Teams 建立附件失敗（HTTP ${created.status}）`);
    const info = (await created.json()) as { uploadUrl?: string; attachmentId?: string; contentUrl?: string };
    if (!info.uploadUrl || !info.attachmentId || !info.contentUrl) throw new Error("Teams 附件資訊不完整");
    const up = await fetchWithLimits(info.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes 0-${data.length - 1}/${data.length}` },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(30_000),
    });
    if (!up.ok) throw new Error(`Teams 附件上傳失敗（HTTP ${up.status}）`);
    await this.sendActivity(conversationId, {
      type: "message",
      text: kind === "image" ? "（圖片）" : `（${name}）`,
      attachments: [{ contentType: "application/octet-stream", contentUrl: info.contentUrl, name, content: { id: info.attachmentId } }],
    });
    logger.info("已傳送媒體（Teams 上傳）", { to: conversationId, kind, file: name, bytes: data.length });
  }

  private async sendSticker(conversationId: string, sticker: StickerInput): Promise<void> {
    logger.info("貼圖降級為文字（Teams）", { to: conversationId });
    await this.rawSendText(conversationId, `（貼圖，Teams 無法顯示：${sticker.packageId}/${sticker.stickerId}）`);
  }

  private async sendLocation(conversationId: string, location: LocationInput): Promise<void> {
    const name = location.title || "位置";
    const mapUrl = `https://www.bing.com/maps?cp=${location.latitude}~${location.longitude}&lvl=15`;
    await this.sendActivity(conversationId, {
      type: "message",
      text: `${name}${location.address ? `\n${location.address}` : ""}\n${mapUrl}`,
    });
    logger.info("已傳送位置（Teams 文字+地圖連結）", { to: conversationId, title: location.title });
  }

  private async sendFlex(conversationId: string, flex: FlexInput): Promise<void> {
    const card = flexToAdaptiveCard(flex);
    await this.sendActivity(conversationId, {
      type: "message",
      text: flex.altText || " ",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
    });
    logger.info("已傳送 Adaptive Card（Teams）", { to: conversationId });
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

  loginStatus(): string {
    return this.loginState;
  }

  stopListening(): void {
    logger.info("Teams 使用 webhook 接收，無需停止監聽");
  }

  stopQueue(): void {
    this.queue.stop();
    this.scheduler.stop();
  }
}
