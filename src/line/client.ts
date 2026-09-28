import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Client, type TalkMessage } from "@evex/linejs";
import { BaseClient } from "@evex/linejs/base";
import { FileStorage } from "@evex/linejs/storage";
import QRCode from "qrcode";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessage } from "../messages.js";
import { recordSend } from "../stats.js";
import { getState, setState } from "../state.js";
import { SendQueue } from "./queue.js";
import { SendScheduler, type Job as ScheduledJob, type ScheduledJobView } from "./scheduler.js";
import { parseCron, nextRun } from "./cron.js";
import { getSkill } from "../skills/index.js";
import { effectiveMode, skillListText, skillUsageText } from "../skills/help.js";
import { watchOptionsToCron } from "../skills/watch.js";
import type { SkillTaskContext, SkillWatchView, WatchOptions } from "../skills/types.js";
import { fetchBuffer } from "../net.js";

const AUTH_KEY = ".auth";
const MID_PATTERN = /^[ucr][0-9a-f]{32}$/i;

export class TargetNotFoundError extends Error {
  constructor(to: string) {
    super(`找不到目標：${to}`);
    this.name = "TargetNotFoundError";
  }
}

export class NotLoggedInError extends Error {
  constructor() {
    super("LINE 尚未登入");
    this.name = "NotLoggedInError";
  }
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 將長文字切成多段，優先切在換行，其次空白，最後硬切。limit <= 0 表示不切。 */
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    // 避免從 surrogate pair 中間切開（emoji 等）。
    while (cut > 0 && cut < rest.length && isLowSurrogate(rest.charCodeAt(cut)) && isHighSurrogate(rest.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    if (cut <= 0) cut = Math.min(limit, rest.length);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

interface LooseContactRaw {
  contact?: { displayName?: string; mid?: string };
  targetProfileDetail?: { profileName?: string };
  displayName?: string;
  targetUserMid?: string;
}

function contactName(raw: unknown): string | undefined {
  const value = raw as LooseContactRaw | undefined;
  return (
    value?.contact?.displayName ||
    value?.targetProfileDetail?.profileName ||
    value?.displayName ||
    undefined
  );
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

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseMs = 800,
): Promise<T> {
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

export class LineService {
  private readonly storage = new FileStorage(config.line.storagePath);
  private readonly queue: SendQueue;
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
    this.queue = new SendQueue(() => ({
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
    }));
    this.scheduler = new SendScheduler(
      (inputs) => this.sendAdvanced(inputs),
      (job) => this.runSkillTask(job),
    );
  }

  /**
   * 技能週期任務觸發分派：找出技能定義並呼叫 onTask。
   * 技能被停用/移除時略過執行（保留排程，重啟技能後恢復）。
   */
  private async runSkillTask(job: ScheduledJob): Promise<void> {
    const ref = job.skillTask;
    if (!ref) return;
    const skillEntry = config.skills.find((s) => s.id === ref.skillId);
    const def = getSkill(ref.skillId);
    if (!skillEntry?.enabled || !def?.onTask) {
      logger.info("略過技能任務（技能停用或無 onTask）", { skill: ref.skillId, task: ref.task, chat: ref.chat });
      return;
    }
    const chat = ref.chat;
    const taskCtx: SkillTaskContext = {
      taskId: job.id,
      task: ref.task,
      chat,
      fromName: "",
      config: skillEntry.config,
      args: { ...ref.args },
      state: { ...(ref.state ?? {}) },
      saveState: async (patch) => {
        this.scheduler.saveSkillState(job.id, { ...(ref.state ?? {}), ...patch });
      },
      reply: (t) => this.replyTo(chat, t),
      sendImage: async (source, filename) => {
        try {
          await this.sendMedia(chat, source, "image", filename);
          recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: true });
        } catch (error) {
          recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: false });
          throw error;
        }
      },
      sendFile: async (source, filename) => {
        try {
          await this.sendMedia(chat, source, "file", filename);
          recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: true });
        } catch (error) {
          recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: false });
          throw error;
        }
      },
    };
    logger.info("觸發技能任務", { skill: ref.skillId, task: ref.task, chat });
    try {
      await def.onTask(taskCtx);
    } catch (error) {
      logger.error("技能任務執行失敗", {
        skill: ref.skillId,
        task: ref.task,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    const base = new BaseClient({
      device: config.line.device,
      storage: this.storage,
    });
    this.base = base;
    this.client = new Client(base);

    // 自訂登入時顯示的裝置名稱（LINE 會顯示「您目前已在「X」上登入」）
    const loginProcess = base.loginProcess;
    const originalForSecure = loginProcess.qrCodeLoginV2ForSecure.bind(loginProcess);
    loginProcess.qrCodeLoginV2ForSecure = (
      authSessionId,
      nonce,
      _modelName,
      _systemName,
      autoLoginIsRequired,
    ) =>
      originalForSecure(
        authSessionId,
        nonce,
        config.line.modelName,
        config.line.deviceName,
        autoLoginIsRequired,
      );

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
      void this.storage.set(AUTH_KEY, token).then(() => {
        logger.info("authToken 已更新並儲存");
      }).catch((error) => {
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
    await this.queue.enqueue(() => this.rawSend(to, text));
  }

  private async rawSend(to: string, text: string): Promise<void> {
    const client = this.client;
    if (!client || !this.loggedIn) throw new NotLoggedInError();

    const mid = this.resolveTarget(to);
    if (!mid) throw new TargetNotFoundError(to);

    await client.base.talk.sendMessage({ to: mid, text, e2ee: true });

    recordSend({ time: new Date().toISOString(), to, type: "text", ok: true });
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
        await this.queue.enqueue(() => this.sendOne(input));
      } catch (error) {
        errors.push(error);
        messages.push(`${input.to}: ${error instanceof Error ? error.message : String(error)}`);
        recordSend({ time: new Date().toISOString(), to: input.to, type: inputType(input), ok: false });
      }
    }
    if (errors.length === 1 && errors[0] instanceof Error) throw errors[0];
    if (errors.length > 0) throw new Error(messages.join("; "));
  }

  private async sendOne(input: SendInput): Promise<void> {
    const client = this.client;
    if (!client || !this.loggedIn) throw new NotLoggedInError();

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

    recordSend({ time: new Date().toISOString(), to: input.to, type: inputType(input), ok: true });
    setState({
      lastSendAt: new Date().toISOString(),
      lastSendTo: this.midToName.get(mid) ?? mid,
    });
  }

  private async sendSticker(to: string, sticker: StickerInput): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError();

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
    if (!client) throw new NotLoggedInError();

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
    if (!client) throw new NotLoggedInError();

    await client.liff.shareMessage(to, {
      type: "flex",
      altText: flex.altText,
      contents: flex.contents,
    });
    logger.info("已傳送 Flex", { to, altText: flex.altText });
  }

  /** 本機檔案只允許上傳/快取目錄，避免 webhook 參數讀到任意系統檔案。 */
  private resolveLocalMediaPath(source: string): string {
    const roots = [resolve(config.uploadsPath), resolve(config.cachePath)];
    const candidate = isAbsolute(source) ? resolve(source) : resolve(roots[0], source);
    for (const root of roots) {
      const rootWithSep = root.endsWith(sep) ? root : root + sep;
      if (candidate === root || candidate.startsWith(rootWithSep)) return candidate;
    }
    throw new Error("僅允許讀取上傳目錄內的檔案（請先經 /settings/upload 上傳）");
  }

  private async sendMedia(
    to: string,
    source: string,
    kind: "image" | "video" | "audio" | "file",
    filename?: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) throw new NotLoggedInError();

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
    const oType =
      kind === "image" ? (ext === ".gif" ? "gif" : "image") : kind;
    const blob = new Blob([data], { type: mimeFor(ext) });

    await client.base.obs.uploadMediaByE2EE({ data: blob, oType, to, filename: name });
    logger.info("已傳送媒體", { to, kind, file: name, bytes: data.length });
  }

  getQueueStats(): { pending: number; running: boolean } {
    return this.queue.stats();
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
      void this.handleIncoming(message);
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

  private async handleIncoming(message: TalkMessage): Promise<void> {
    const client = this.client;
    if (!client) return;

    try {
      if (message.isMyMessage) return;

      const text = (message.text ?? "").trim();
      const toId = message.to.id;
      const chat = toId === this.myMid ? message.from.id : toId;
      const fromName = this.midToName.get(message.from.id) ?? "";
      const chatName = this.midToName.get(chat) ?? "";

      recordMessage({
        time: new Date().toISOString(),
        fromMid: message.from.id,
        fromName,
        chatMid: chat,
        chatType: String(message.to.type ?? ""),
        text,
      });

      if (!chat) return;

      await this.runCommand(text, chat, message.from.id);
      await this.runSkills(text, chat, fromName, message.from.id);
      await this.runForwardRules(text, chat, fromName, chatName);
    } catch (error) {
      logger.error("處理收到的訊息失敗", { error: String(error) });
    }
  }

  private async runSkills(
    text: string,
    chat: string,
    fromName: string,
    fromMid: string,
  ): Promise<void> {
    if (!text) return;

    const assistant = config.assistant.name.trim();
    // 計算「助理前綴」後剩餘文字（僅 assistant 模式需要）
    let rest = "";
    let hasAssistantPrefix = false;
    if (assistant && text.startsWith(assistant)) {
      rest = text.slice(assistant.length).trim();
      const polite = /^(請幫忙|請幫|幫忙|麻煩|幫我|幫)\s*/;
      for (let i = 0; i < 3; i++) {
        const next = rest.replace(polite, "");
        if (next === rest) break;
        rest = next;
      }
      hasAssistantPrefix = true;
    }

    // Layer 1：只喊助理名稱、未帶觸發詞 → 列出可用技能
    if (config.assistant.enabled && hasAssistantPrefix && rest === "") {
      logger.info("列出可用技能", { chat });
      await this.replyTo(chat, skillListText(config.language));
      return;
    }

    for (const skill of config.skills) {
      if (!skill.enabled) continue;
      const def = getSkill(skill.id);
      if (!def) continue;

      const mode = effectiveMode(skill, def);
      let args: string | null = null;

      if (mode === "any") {
        args = text;
      } else {
        if (!config.assistant.enabled || !hasAssistantPrefix || !rest) continue;
        const primary = (skill.trigger || def.defaultTrigger).trim();
        const triggers = [primary, ...(def.triggerAliases ?? [])].filter(Boolean);
        let matched = "";
        for (const t of triggers) {
          if (rest.startsWith(t)) {
            matched = t;
            break;
          }
        }
        if (!matched) continue;
        args = rest.slice(matched.length).trim();

        // Layer 2：<觸發詞> ? → 顯示該技能用法
        if (/^[?？]$/.test(args) || /^(help|用法|說明)$/i.test(args)) {
          const primaryTrigger = (skill.trigger || def.defaultTrigger).trim();
          logger.info("顯示技能用法", { skill: skill.id, chat });
          await this.replyTo(chat, skillUsageText(def, primaryTrigger, config.language));
          continue;
        }
      }
      if (args === null) continue;

      logger.info("觸發技能", { skill: skill.id, mode, chat });
      try {
        const skillId = skill.id;
        const toWatchView = (job: ScheduledJobView): SkillWatchView => ({
          id: job.id,
          task: job.skillTask?.task ?? "",
          cron: job.repeat ?? "",
          runAt: job.runAt,
          args: { ...(job.skillTask?.args ?? {}) },
        });
        await def.run({
          text,
          args,
          fromName,
          chat,
          fromMid,
          config: skill.config,
          reply: (t) => this.replyTo(chat, t),
          sendImage: async (source, filename) => {
            try {
              await this.sendMedia(chat, source, "image", filename);
              recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: true });
            } catch (error) {
              recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: false });
              throw error;
            }
          },
          sendFile: async (source, filename) => {
            try {
              await this.sendMedia(chat, source, "file", filename);
              recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: true });
            } catch (error) {
              recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: false });
              throw error;
            }
          },
          schedule: (text, runAt) => this.schedule([{ to: chat, text }], runAt).id,
          watch: (opts) => this.scheduleSkillTask(skillId, chat, opts).id,
          unwatch: (taskOrId) => {
            const jobs = this.listSkillTasks({ skillId, chat });
            const byId = jobs.find((j) => j.id === taskOrId);
            if (byId) return this.scheduler.cancel(byId.id);
            const byTask = jobs.find((j) => j.skillTask?.task === taskOrId);
            if (byTask) return this.scheduler.cancel(byTask.id);
            return false;
          },
          watches: () => this.listSkillTasks({ skillId, chat }).map(toWatchView),
          taskState: (taskOrId) => {
            const jobs = this.listSkillTasks({ skillId, chat });
            const job =
              jobs.find((j) => j.id === taskOrId) ??
              jobs.find((j) => j.skillTask?.task === taskOrId);
            return job ? this.readTaskState(job.id) : undefined;
          },
        });
      } catch (error) {
        logger.error("技能執行失敗", { skill: skill.id, error: String(error) });
        await this.replyTo(chat, `技能「${def.name}」執行失敗：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async runForwardRules(
    text: string,
    chat: string,
    fromName: string,
    chatName: string,
  ): Promise<void> {
    if (!text) return;
    for (const rule of config.forward) {
      if (!rule.enabled || !rule.target) continue;
      if (rule.source && rule.source.trim() !== "" && rule.source.trim() !== chat) continue;

      let matched: boolean;
      if (rule.match === "all") matched = true;
      else if (rule.match === "regex") {
        try {
          matched = new RegExp(rule.keyword, "i").test(text);
        } catch {
          matched = false;
        }
      } else {
        const keywords = rule.keyword
          .split("|")
          .map((k) => k.trim())
          .filter(Boolean);
        matched = keywords.length === 0 || keywords.some((k) => text.includes(k));
      }
      if (!matched) continue;

      const parts: string[] = [];
      if (rule.prefix) parts.push(rule.prefix);
      if (rule.includeSender) parts.push(`[${chatName || fromName || "未知"}]`);
      parts.push(text);
      const forwarded = parts.join(" ");

      try {
        await this.queue.enqueue(() => this.rawSend(rule.target, forwarded));
        logger.info("訊息已轉發（規則）", { from: chat, to: rule.target });
      } catch (error) {
        logger.error("轉發規則失敗", { to: rule.target, error: String(error) });
      }
    }
  }

  private async runCommand(text: string, chat: string, fromMid: string): Promise<void> {
    if (!config.commands.enabled) return;
    const prefix = config.commands.prefix || "!";
    if (!text.startsWith(prefix)) return;

    const allow = config.commands.allowFrom.map((item) => item.trim()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(fromMid) && !allow.includes(chat)) {
      logger.info("指令來源未授權，略過", { fromMid });
      return;
    }

    const rest = text.slice(prefix.length).trim();
    const spaceIdx = rest.indexOf(" ");
    const command = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

    try {
      if (command === "help" || command === "指令") {
        const asst = config.assistant.name.trim() || "助理";
        await this.replyTo(
          chat,
          [
            "可用指令：help、status、send <對象> <訊息>、id",
            `技能清單：${asst}請幫忙`,
            `技能用法：${asst}請幫忙 <觸發詞> ?`,
          ].join("\n"),
        );
      } else if (command === "status") {
        const state = getState();
        const lines = [
          `狀態：${state.status}`,
          `帳號：${state.profileName ?? "-"}`,
          `好友：${state.friendCount ?? 0} / 群組：${state.chatCount ?? 0}`,
          `排程：${this.scheduler.list().length}`,
          `佇列：${this.queue.stats().pending}`,
        ];
        await this.replyTo(chat, lines.join("\n"));
      } else if (command === "id") {
        await this.replyTo(chat, `chat=${chat}\nfrom=${fromMid}`);
      } else if (command === "send") {
        const sep = args.indexOf(" ");
        if (sep <= 0) {
          await this.replyTo(chat, "用法：send <對象> <訊息>");
          return;
        }
        const target = args.slice(0, sep).trim();
        const body = args.slice(sep + 1).trim();
        await this.sendAdvanced([{ to: target, text: body }]);
        await this.replyTo(chat, `已發送給 ${target}`);
      } else {
        await this.replyTo(chat, `未知指令：${command}（可用 help）`);
      }
    } catch (error) {
      logger.error("執行指令失敗", { command, error: String(error) });
      await this.replyTo(chat, `指令失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async replyTo(chat: string, text: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    // 前綴「(n/N) 」會佔用長度，先預留再切段；段數設上限避免洗版。
    const maxLen = Math.max(200, config.replyMaxChars - 10);
    let parts = splitText(text, maxLen);
    const MAX_PARTS = 10;
    if (parts.length > MAX_PARTS) {
      parts = parts.slice(0, MAX_PARTS);
      parts[MAX_PARTS - 1] = `${parts[MAX_PARTS - 1]}…（內容過長已截斷）`;
    }
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const body = parts.length > 1 ? `(${i + 1}/${parts.length}) ${parts[i]}` : parts[i];
      try {
        await client.base.talk.sendMessage({ to: chat, text: body, e2ee: true });
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: true });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "text", ok: false });
        throw error;
      }
      if (!isLast) await delay(config.send.minIntervalMs);
    }
  }

  listTargets(): Array<{ name: string; mid: string }> {
    return [...this.nameToMid.entries()].map(([name, mid]) => ({ name, mid }));
  }
}
