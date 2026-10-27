import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { Client, type TalkMessage } from "@evex/linejs";
import { BaseClient } from "@evex/linejs/base";
import { FileStorage } from "@evex/linejs/storage";
import QRCode from "qrcode";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessage } from "../messages.js";
import { recordSend } from "../stats.js";
import { writeDeadLetter } from "../deadletter.js";
import { getState, setState } from "../state.js";
import { SendQueue, fileQueuePersistence, nextQueueKey } from "./queue.js";
import { SendScheduler, type ScheduledJobView } from "./scheduler.js";
import { parseCron, nextRun } from "./cron.js";
import { watchOptionsToCron } from "../skills/watch.js";
import type { WatchOptions } from "../skills/types.js";
import { dispatchIncoming, dispatchSkillTask, type DispatchDeps } from "../messaging/dispatch.js";
import { extractLocationFromText } from "../messaging/location.js";
import { chunkReplyText } from "../messaging/text.js";
import { resolveLocalMediaPath } from "../messaging/media.js";
import type { FlexInput, IMessagingService, LocationInput, QueuedSend, SendInput, StickerInput } from "../messaging/types.js";
import { NotLoggedInError, TargetNotFoundError } from "../messaging/types.js";
import type { IncomingImage } from "../messaging/types.js";

/** 收到圖片轉 base64 的上限（LLM 請求體限制；超過就略過附件）。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export type { FlexInput, LocationInput, SendInput, StickerInput } from "../messaging/types.js";
import { fetchBuffer } from "../net.js";

const AUTH_KEY = ".auth";
const MID_PATTERN = /^[ucr][0-9a-f]{32}$/i;

// 錯誤類住在 messaging/types.ts（各傳輸層共用）；此處 re-export 保持相容。
export { NotLoggedInError, TargetNotFoundError } from "../messaging/types.js";

export function inputType(input: SendInput): string {
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

type SendMessageOptions = Parameters<BaseClient["talk"]["sendMessage"]>[0];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 單則發送逾時（evex promise 偶爾不 settle，不能讓回覆卡到天荒地老）。 */
const REPLY_SEND_TIMEOUT_MS = 30_000;

/** 回覆消毒：清控制字（保留 \t\n\r）與 ANSI 轉義；這些在聊天室顯示不了，還可能搞壞發送。 */
export function sanitizeReplyText(text: string): string {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** 比賽：本體先回就用本體的，逾時先到就丟錯（本體之後才回也無害）。 */
export function withSendTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {

  // 掛一個已處理的分支，避免本體晚到時變成 unhandled rejection 噪音。
  task.catch(() => {});
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

// splitText 住在 messaging/text.ts（各傳輸層共用）；此處 re-export 保持相容。
export { splitText } from "../messaging/text.js";

interface LooseContactRaw {
  contact?: { displayName?: string; mid?: string };
  targetProfileDetail?: { profileName?: string };
  displayName?: string;
  targetUserMid?: string;
}

function contactName(raw: unknown): string | undefined {
  const value = raw as LooseContactRaw | undefined;
  return value?.contact?.displayName || value?.targetProfileDetail?.profileName || value?.displayName || undefined;
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFor(ext: string): string {
  return MIME_TYPES[ext] ?? "application/octet-stream";
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

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, baseMs = 800): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        const wait = baseMs * 2 ** i;
        logger.warn(`${label}失敗，將重試`, {
          attempt: i + 1,
          waitMs: wait,
          error: String(error),
        });
        await delay(wait);
      }
    }
  }
  throw lastError;
}

export class LineService implements IMessagingService {
  readonly platform = "line" as const;
  // 會在 doInit() 重建，讓設定頁改完 Session 儲存目錄後「重新登入」即可生效（與 WhatsApp Web 的 webAuthPath 同）。
  private storage = new FileStorage(config.line.storagePath);
  private readonly queue: SendQueue<QueuedSend>;
  private readonly scheduler: SendScheduler;
  private base: BaseClient | null = null;
  private client: Client | null = null;
  private nameToMid = new Map<string, string>();
  private midToName = new Map<string, string>();
  private friendCount = 0;
  private chatCount = 0;
  private busy = false;
  private loggedIn = false;
  private myMid = "";
  private listenAbort: AbortController | null = null;

  constructor() {
    this.queue = new SendQueue<QueuedSend>(
      () => ({
        maxRetries: config.send.maxRetries,
        retryBaseMs: config.send.retryBaseMs,
        minIntervalMs: config.send.minIntervalMs,
        isPermanent: (error) => {
          if (error instanceof TargetNotFoundError || error instanceof NotLoggedInError) return true;
          const message = error instanceof Error ? error.message : String(error);
          // 明顯的暫時性錯誤（限流/逾時/連線）一定要重試。
          if (/429|rate|頻繁|timeout|逾時|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up/i.test(message)) {
            return false;
          }
          // 參數/驗證類錯誤重試也不會成功，直接失敗避免卡住佇列。
          return /40[0-4]|422|驗證失敗|參數錯誤|不支援|格式錯誤|找不到/i.test(message);
        },
      }),
      {
        // P0-4：待發任務落檔（data/queue-line.json），重啟後由 start() 續送。
        persistence: fileQueuePersistence<QueuedSend>(join(dirname(config.schedulesPath), "queue-line.json")),
        send: (data) => (data.kind === "text" ? this.rawSend(data.to, data.text) : this.sendOne(data.input)),
      },
    );
    this.scheduler = new SendScheduler(
      (inputs) => this.sendAdvanced(inputs),
      (job) => dispatchSkillTask(job, this.dispatchDeps()),
    );
  }

  /** 共用分派管線所需的傳輸能力（指令・技能・轉發・技能任務邏輯見 messaging/dispatch）。 */
  private dispatchDeps(): DispatchDeps {
    return {
      platform: "line",
      replyTo: (chat, text) => this.replyTo(chat, text),
      sendAdvanced: (inputs) => this.sendAdvanced(inputs),
      sendMedia: (chat, source, kind, filename) => this.sendMedia(chat, source, kind, filename),
      schedule: (inputs, runAt, repeat) => this.schedule(inputs, runAt, repeat),
      scheduleSkillTask: (skillId, chat, opts) => this.scheduleSkillTask(skillId, chat, opts),
      listSkillTasks: (filter) => this.listSkillTasks(filter),
      readTaskState: (id) => this.readTaskState(id),
      saveTaskState: (id, state) => this.saveTaskState(id, state),
      cancelScheduledTask: (id) => this.scheduler.cancel(id),
      updateScheduledTask: (id, patch) => this.updateScheduled(id, patch),
      enqueueText: (to, text) => this.enqueueText(to, text),
      getQueueStats: () => this.getQueueStats(),
      listScheduled: () => this.listScheduled(),
    };
  }

  /** 純文字入佇列（轉發規則用）。 */
  async enqueueText(to: string, text: string): Promise<void> {
    await this.queue.enqueue(nextQueueKey(), { kind: "text", to, text });
  }

  /** 更新技能任務 state 並持久化。 */
  saveTaskState(id: string, state: Record<string, unknown>): boolean {
    return this.scheduler.saveSkillState(id, state);
  }

  /**
   * 註冊（或取代）技能週期任務。同 skillId+task+chat 再次註冊會取代舊任務。
   * 回傳排程檢視（含 id）。
   */
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
      state: { ...((opts.state ?? {}) as Record<string, unknown>) },
    });
  }

  /** 讀取技能任務 state 副本；找不到回 undefined。 */
  readTaskState(id: string): Record<string, unknown> | undefined {
    const ref = this.scheduler.getSkillTask(id);
    const state = ref?.state;
    return state ? { ...state } : undefined;
  }

  /** 列出技能任務（可選填 skillId / chat 過濾）。 */
  listSkillTasks(filter?: { skillId?: string; chat?: string }): ScheduledJobView[] {
    return this.scheduler.list().filter((job) => {
      const st = job.skillTask;
      if (!st) return false;
      if (filter?.skillId && st.skillId !== filter.skillId) return false;
      if (filter?.chat && st.chat !== filter.chat) return false;
      return true;
    });
  }

  async init(): Promise<void> {
    this.busy = true;
    try {
      await this.doInit();
    } finally {
      this.busy = false;
    }
  }

  private async doInit(): Promise<void> {
    this.loggedIn = false;
    this.storage = new FileStorage(config.line.storagePath);
    const base = new BaseClient({
      device: config.line.device,
      storage: this.storage,
    });
    this.base = base;
    this.client = new Client(base);

    // 自訂登入時顯示的裝置名稱（LINE 會顯示「您目前已在「X」上登入」）
    const loginProcess = base.loginProcess;
    const originalForSecure = loginProcess.qrCodeLoginV2ForSecure.bind(loginProcess);
    loginProcess.qrCodeLoginV2ForSecure = (authSessionId, nonce, _modelName, _systemName, autoLoginIsRequired) =>
      originalForSecure(authSessionId, nonce, config.line.modelName, config.line.deviceName, autoLoginIsRequired);

    base.on("qrcall", (url) => {
      logger.warn("需要 QR 驗證，請用手機 LINE 掃描（終端機或狀態頁）", { url });
      setState({ status: "待驗證", qrUrl: url, pin: undefined });
      void QRCode.toString(url, { type: "terminal", small: true })
        .then((qr) => {
          console.log("\n請用手機 LINE 的掃描功能掃描以下 QR Code：\n");
          console.log(qr);
        })
        .catch(() => {});
    });
    base.on("pincall", (pin) => {
      logger.warn("需要 PIN 驗證，請在手機輸入", { pin });
      setState({ status: "待驗證", pin, qrUrl: undefined });
    });
    base.on("update:authtoken", (token) => {
      void this.storage
        .set(AUTH_KEY, token)
        .then(() => {
          logger.info("authToken 已更新並儲存");
        })
        .catch((error) => {
          logger.error("authToken 儲存失敗", { error: String(error) });
        });
    });

    const cached = await this.storage.get(AUTH_KEY);
    if (typeof cached === "string" && cached) {
      try {
        await base.loginProcess.login({ authToken: cached });
      } catch (error) {
        logger.warn("authToken 失效，改用 QR 驗證", { error: String(error) });
        await base.loginProcess.login({ qr: true });
      }
    } else {
      await base.loginProcess.login({ qr: true });
    }

    const profile = await this.client.getMyProfile();
    await this.refreshContacts();
    this.loggedIn = true;
    this.queue.start();
    this.myMid = profile.mid;

    setState({
      status: "已登入",
      profileName: profile.displayName,
      myMid: profile.mid,
      lastLoginAt: new Date().toISOString(),
      lastError: undefined,
      qrUrl: undefined,
      pin: undefined,
    });
    logger.info("LINE 登入完成", { name: profile.displayName, mid: profile.mid });
    this.startListening();

    if (this.friendCount === 0) {
      setTimeout(() => {
        if (this.loggedIn) void this.refreshContacts();
      }, 5000).unref?.();
    }
  }

  async refreshContacts(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const nameToMid = new Map<string, string>();
    const midToName = new Map<string, string>();

    try {
      const users = await withRetry("抓取好友清單", () => client.fetchUsers());
      this.friendCount = users.length;
      for (const user of users) {
        const name = contactName(user.raw);
        if (name) {
          nameToMid.set(name, user.mid);
          midToName.set(user.mid, name);
        }
      }
    } catch (error) {
      logger.warn("抓取好友清單失敗", { error: String(error) });
    }

    try {
      const chats = await withRetry("抓取群組清單", () => client.fetchJoinedChats());
      this.chatCount = chats.length;
      for (const chat of chats) {
        if (chat.name) {
          nameToMid.set(chat.name, chat.mid);
          midToName.set(chat.mid, chat.name);
        }
      }
    } catch (error) {
      logger.warn("抓取群組清單失敗", { error: String(error) });
    }

    for (const [name, mid] of Object.entries(config.targets)) {
      nameToMid.set(name, mid);
      if (!midToName.has(mid)) midToName.set(mid, name);
    }

    this.nameToMid = nameToMid;
    this.midToName = midToName;
    setState({ friendCount: this.friendCount, chatCount: this.chatCount });
    logger.info("聯絡人對照表已建立", {
      friends: this.friendCount,
      chats: this.chatCount,
    });
  }

  resolveTarget(to: string): string | null {
    const trimmed = to.trim();
    const byName = this.nameToMid.get(trimmed);
    if (byName) return byName;
    if (this.midToName.has(trimmed) || MID_PATTERN.test(trimmed)) return trimmed;
    return null;
  }

  async send(to: string, text: string): Promise<void> {
    await this.queue.enqueue(nextQueueKey(), { kind: "text", to, text });
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const client = this.client;
    if (!client || !this.loggedIn) throw new NotLoggedInError("LINE");

    const mid = this.resolveTarget(to);
    if (!mid) throw new TargetNotFoundError(to);

    await client.base.talk.sendMessage({ to: mid, text, e2ee: true });

    recordSend({ time: new Date().toISOString(), to, type: "text", ok: true, platform: "line" });
    setState({
      lastSendAt: new Date().toISOString(),
      lastSendTo: this.midToName.get(mid) ?? mid,
    });
  }

  async sendAdvanced(inputs: SendInput[]): Promise<void> {
    const errors: unknown[] = [];
    const messages: string[] = [];
    for (const input of inputs) {
      try {
        await this.queue.enqueue(nextQueueKey(), { kind: "one", input });
      } catch (error) {
        errors.push(error);
        messages.push(`${input.to}: ${error instanceof Error ? error.message : String(error)}`);
        recordSend({
          time: new Date().toISOString(),
          to: input.to,
          type: inputType(input),
          ok: false,
          platform: "line",
        });
        writeDeadLetter({
          platform: "line",
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
    const client = this.client;
    if (!client || !this.loggedIn) throw new NotLoggedInError("LINE");

    const mid = this.resolveTarget(input.to);
    if (!mid) throw new TargetNotFoundError(input.to);

    if (input.image) await this.sendMedia(mid, input.image, "image", input.filename);
    if (input.video) await this.sendMedia(mid, input.video, "video", input.filename);
    if (input.audio) await this.sendMedia(mid, input.audio, "audio", input.filename);
    if (input.file) await this.sendMedia(mid, input.file, "file", input.filename);
    if (input.sticker) await this.sendSticker(mid, input.sticker);
    if (input.location) await this.sendLocation(mid, input.location);
    if (input.flex) await this.sendFlex(mid, input.flex);
    if (input.text) {
      await client.base.talk.sendMessage({ to: mid, text: input.text, e2ee: true });
    }

    recordSend({ time: new Date().toISOString(), to: input.to, type: inputType(input), ok: true, platform: "line" });
    setState({
      lastSendAt: new Date().toISOString(),
      lastSendTo: this.midToName.get(mid) ?? mid,
    });
  }

  private async sendSticker(to: string, sticker: StickerInput): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError("LINE");

    await client.liff.shareMessage(to, {
      type: "sticker",
      packageId: String(sticker.packageId),
      stickerId: String(sticker.stickerId),
    });
    logger.info("已傳送貼圖", {
      to,
      packageId: sticker.packageId,
      stickerId: sticker.stickerId,
    });
  }

  private async sendLocation(to: string, location: LocationInput): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError("LINE");

    const payload = {
      title: location.title,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
    } as unknown as SendMessageOptions["location"];

    await client.base.talk.sendMessage({
      to,
      location: payload,
      contentType: "LOCATION",
      e2ee: true,
    });
    logger.info("已傳送位置", { to, title: location.title });
  }

  private async sendFlex(to: string, flex: FlexInput): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError("LINE");

    await client.liff.shareMessage(to, {
      type: "flex",
      altText: flex.altText,
      contents: flex.contents,
    });
    logger.info("已傳送 Flex", { to, altText: flex.altText });
  }

  /** 本機檔案只允許上傳/快取目錄，避免 webhook 參數讀到任意系統檔案。 */
  private resolveLocalMediaPath(source: string): string {
    return resolveLocalMediaPath(source, config.uploadsPath, config.cachePath);
  }

  private async sendMedia(
    to: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError("LINE");

    const maxBytes = Math.max(1, config.maxBodyMb) * 1024 * 1024;
    let data: Buffer;
    let name: string;

    const dataUrl = /^data:([^;,]*);base64,(.*)$/is.exec(source);
    if (dataUrl) {
      data = Buffer.from(dataUrl[2], "base64");
      if (data.length > maxBytes) throw new Error(`媒體過大（上限 ${config.maxBodyMb}MB）`);
      name = filename?.trim() || `upload.${extFor(kind, dataUrl[1])}`;
    } else if (/^https?:\/\//i.test(source)) {
      try {
        data = await fetchBuffer(source, undefined, { timeoutMs: 20_000, maxBytes });
      } catch {
        throw new Error(`下載失敗：${source}`);
      }
      let pathname = "media.bin";
      try {
        pathname = basename(new URL(source).pathname) || pathname;
      } catch {
        // URL 解析失敗時沿用預設檔名
      }
      name = filename?.trim() || pathname;
    } else {
      const safePath = this.resolveLocalMediaPath(source);
      try {
        data = readFileSync(safePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`檔案不存在：${safePath}（請先經 /settings/upload 上傳）`);
        }
        throw error;
      }
      if (data.length > maxBytes) throw new Error(`媒體過大（上限 ${config.maxBodyMb}MB）`);
      name = filename?.trim() || basename(safePath);
    }

    const ext = extname(name).toLowerCase();
    const oType = kind === "image" ? (ext === ".gif" ? "gif" : "image") : kind;
    const blob = new Blob([data], { type: mimeFor(ext) });

    await client.base.obs.uploadMediaByE2EE({ data: blob, oType, to, filename: name });
    logger.info("已傳送媒體", { to, kind, file: name, bytes: data.length });
  }

  getQueueStats(): { pending: number; running: boolean } {
    return this.queue.stats();
  }

  loginStatus(): string {
    return getState().status;
  }

  getQr(): string {
    return getState().qrUrl ?? "";
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

  stopQueue(): void {
    this.queue.stop();
    this.scheduler.stop();
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client || !this.loggedIn) return false;
    try {
      await this.client.getMyProfile();
      return true;
    } catch {
      return false;
    }
  }

  async recover(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.doInit();
      return true;
    } catch (error) {
      logger.error("自動重登失敗，需人工重新驗證", { error: String(error) });
      setState({ status: "需人工", lastError: String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }

  private startListening(): void {
    const client = this.client;
    if (!client) return;

    client.on("message", (message) => {
      void this.handleLineMessage(message);
    });

    this.listenAbort?.abort();
    this.listenAbort = new AbortController();
    client.listen({ talk: true, square: false, signal: this.listenAbort.signal });
    logger.info("已開始接收訊息（關鍵字自動回覆）");
  }

  stopListening(): void {
    this.listenAbort?.abort();
    this.listenAbort = null;
  }

  private async handleLineMessage(message: TalkMessage): Promise<void> {
    const client = this.client;
    if (!client) return;

    try {
      if (message.isMyMessage) return;

      const text = (message.text ?? "").trim();
      const toId = message.to.id;
      const chat = toId === this.myMid ? message.from.id : toId;
      const fromName = this.midToName.get(message.from.id) ?? "";
      const chatName = this.midToName.get(chat) ?? "";

      // 圖片訊息：抓 blob 轉 base64 帶給技能（AI 圖片理解用）；只在 IMAGE（1）時抓
      let images: IncomingImage[] | undefined;
      const contentType = (message.raw as { contentType?: number | string }).contentType;
      if (contentType === 1 || contentType === "IMAGE") {
        try {
          const blob = await message.getData();
          const buf = Buffer.from(await blob.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_IMAGE_BYTES) {
            images = [{ base64: buf.toString("base64"), mimeType: "image/jpeg" }];
          } else if (buf.length > MAX_IMAGE_BYTES) {
            logger.warn("收到過大的圖片，略過附件", { bytes: buf.length });
          }
        } catch (error) {
          logger.warn("讀取圖片訊息失敗", { error: String(error) });
        }
      }

      // 位置訊息：raw.location 帶經緯度（contentType 15）；自帳號有時只收到
      // 文字版「[ Location ]＋地圖連結」，此時從文字還原。
      const rawLoc = (message.raw as { location?: { latitude?: number | string; longitude?: number | string; title?: unknown; address?: unknown } }).location;
      const lat = Number(rawLoc?.latitude);
      const lon = Number(rawLoc?.longitude);
      const location =
        rawLoc && Number.isFinite(lat) && Number.isFinite(lon)
          ? {
              latitude: lat,
              longitude: lon,
              ...(typeof rawLoc.title === "string" && rawLoc.title ? { title: rawLoc.title } : {}),
              ...(typeof rawLoc.address === "string" && rawLoc.address ? { address: rawLoc.address } : {}),
            }
          : extractLocationFromText(text);

      recordMessage({
        time: new Date().toISOString(),
        fromMid: message.from.id,
        fromName,
        chatMid: chat,
        chatType: String(message.to.type ?? ""),
        text,
      });

      const rawId = (message as unknown as { id?: string | number }).id;
      await dispatchIncoming(
        {
          chat,
          fromId: message.from.id,
          fromName,
          chatName,
          text,
          messageId: rawId == null ? undefined : String(rawId),
          ...(images ? { images } : {}),
          ...(location ? { location } : {}),
        },
        this.dispatchDeps(),
      );
    } catch (error) {
      logger.error("處理收到的訊息失敗", { error: String(error) });
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const client = this.client;
    // 曾經是靜默 return（未登入的空窗回覆直接人間蒸發，還記成功）；現在丟錯讓上層看見。
    if (!client) throw new NotLoggedInError("LINE");
    // CLI 之類的上游偶爾夾帶控制字／ANSI（聊天室顯示不了，極端情況整則送達異常）：先清掉。
    const clean = sanitizeReplyText(text);
    const parts = chunkReplyText(clean, config.replyMaxChars);
    if (parts.length === 0) throw new Error("回覆內容為空（清理控制字後無可用文字）");
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const part = parts[i] as string;
      try {
        await withSendTimeout(
          client.base.talk.sendMessage({ to: chat, text: part, e2ee: true }),
          REPLY_SEND_TIMEOUT_MS,
          `LINE 回覆逾時（第 ${i + 1}/${parts.length} 段）`,
        );
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true, platform: "line" });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false, platform: "line" });
        throw error;
      }
      if (!isLast) await delay(config.send.minIntervalMs);
    }
  }

  listTargets(): Array<{ name: string; id: string }> {
    return [...this.nameToMid.entries()].map(([name, mid]) => ({ name, id: mid }));
  }
}
