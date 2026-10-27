import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";

export interface SendQueueOptions {
  maxRetries: number;
  retryBaseMs: number;
  minIntervalMs: number;
  isPermanent: (error: unknown) => boolean;
}

/** 可持久化的任務（純資料；執行函式由建構時的 send 提供， crash 後重建）。 */
export interface PersistedQueueTask<D> {
  key: string;
  data: D;
  attempts: number;
  enqueuedAt: number;
}

export interface QueuePersistence<D> {
  load(): PersistedQueueTask<D>[];
  save(tasks: PersistedQueueTask<D>[]): void;
}

export interface QueueHooks<D> {
  persistence?: QueuePersistence<D>;
  /** 發送一個任務（含開機續送的重建任務）。 */
  send: (data: D) => Promise<void>;
}

interface LiveTask<D> extends PersistedQueueTask<D> {
  settle: () => void;
  fail: (error: unknown) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 殘留任務 TTL：超過 24 小時的開機時丟棄（活太久就別送了）。 */
const STALE_MS = 24 * 3600_000;
/** 入佇列防抖落檔間隔（成功／失敗當下同步寫，入佇列與重試計數用防抖）。 */
const SAVE_DEBOUNCE_MS = 2000;

let keyCounter = 0;
/** 產生冪等鍵（每次發送取一個；同 key 重複入佇列會被擋下）。 */
export function nextQueueKey(): string {
  keyCounter = (keyCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${keyCounter.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

/** 檔案持久化（原子 rename；讀寫失敗只記 log，不擊倒發送）。 */
export function fileQueuePersistence<D>(path: string): QueuePersistence<D> {
  return {
    load: () => {
      try {
        if (!existsSync(path)) return [];
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(raw)) return [];
        const out: PersistedQueueTask<D>[] = [];
        for (const t of raw) {
          if (!t || typeof t !== "object") continue;
          const r = t as Partial<PersistedQueueTask<D>>;
          if (typeof r.key !== "string" || !r.key || r.data === undefined) continue;
          out.push({
            key: r.key,
            data: r.data as D,
            attempts: typeof r.attempts === "number" && r.attempts >= 0 ? Math.floor(r.attempts) : 0,
            enqueuedAt: typeof r.enqueuedAt === "number" ? r.enqueuedAt : 0,
          });
        }
        return out;
      } catch (error) {
        logger.warn("讀取發送佇列存檔失敗", { path, error: String(error) });
        return [];
      }
    },
    save: (tasks) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(tasks), "utf8");
        renameSync(tmp, path);
      } catch (error) {
        logger.warn("儲存發送佇列存檔失敗", { path, error: String(error) });
      }
    },
  };
}

/**
 * P0-4 可續送的發送佇列：任務是純資料（key＋data＋attempts），可落檔；
 * 開機時把上次沒送完的搬回來續送（去重＋過期丟棄＋上限裁剪）。
 * 語意為至少一次（at-least-once）：settled 後才從存檔移除，crash 邊界可能重送，
 * 同 key 在佇列內重複入佇列會被擋下（行程內冪等）。
 */
export class SendQueue<D = unknown> {
  private readonly queue: LiveTask<D>[] = [];
  /** 開機載入的待續送任務（另存，不擋 live 排水；start() 才併入）。 */
  private parked: PersistedQueueTask<D>[] = [];
  /** 正在送的任務（已 shift 出陣列；crash 時靠它續送，否則送一半的會人間蒸發）。 */
  private current: LiveTask<D> | null = null;
  private running = false;
  private stopped = false;
  private lastSendAt = 0;
  private readonly maxDepth = 1000;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getOptions: () => SendQueueOptions,
    private readonly hooks: QueueHooks<D> = { send: () => Promise.reject(new Error("未設定發送函式")) },
  ) {
    // 只搬貨不開送：登入完成前排水會因 NotLoggedIn 秒失敗。
    // 續送任務另存 parked（不擋 live），由各平台在就緒後呼叫 start() 併入
    //（token 類在 init 成功尾、QR 類在登入完成時；漏接只少續送，不影響正常發送）。
    const persist = hooks.persistence;
    if (!persist) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const t of persist.load()) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      if (now - t.enqueuedAt >= STALE_MS) continue;
      this.parked.push(t);
    }
    this.parked = this.parked.slice(-this.maxDepth);
    if (this.parked.length > 0) logger.info("發送佇列載入待續送任務", { count: this.parked.length });
    this.persistNow();
  }

  /**
   * 把開機續送任務併入佇列並開始排水（去重：live 已有同 key 就不併）。
   * 可重複呼叫（冪等）；沒調用也不影響正常發送。
   */
  start(): void {
    if (this.stopped || this.parked.length === 0) return;
    const live = new Set(this.queue.map((t) => t.key));
    let n = 0;
    for (const t of this.parked.splice(0)) {
      if (live.has(t.key)) continue;
      live.add(t.key);
      this.queue.push({ ...t, settle: () => {}, fail: () => {} });
      n += 1;
    }
    if (n > 0) logger.info("發送佇列開始續送", { count: n });
    this.persistNow();
    void this.drain();
  }

  enqueue(key: string, data: D): Promise<void> {
    if (!key) return Promise.reject(new Error("發送任務缺少冪等鍵"));
    if (this.stopped) return Promise.reject(new Error("發送佇列已停止"));
    if (this.queue.length >= this.maxDepth) {
      return Promise.reject(new Error("發送佇列已滿，請稍後再試"));
    }
    // 冪等：排隊中、正在送、待續送（parked）有同 key 都擋下。
    if (this.queue.some((t) => t.key === key) || this.current?.key === key || this.parked.some((t) => t.key === key)) {
      return Promise.reject(new Error("重複的發送任務（冪等鍵已存在）"));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ key, data, attempts: 0, enqueuedAt: Date.now(), settle: resolve, fail: reject });
      this.persistSoon();
      void this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    // 存檔留下次開機續送（優雅重啟不丟任務）；呼叫端照常收到拒絕。
    this.persistNow();
    for (const task of this.queue.splice(0)) {
      task.fail(new Error("發送佇列已停止"));
    }
  }

  stats(): { pending: number; running: boolean } {
    return { pending: this.queue.length + this.parked.length, running: this.running };
  }

  private snapshot(): PersistedQueueTask<D>[] {
    const parked = this.parked.map((t) => ({ key: t.key, data: t.data, attempts: t.attempts, enqueuedAt: t.enqueuedAt }));
    const flying = this.current
      ? [{ key: this.current.key, data: this.current.data, attempts: this.current.attempts, enqueuedAt: this.current.enqueuedAt }]
      : [];
    const live = this.queue.map((t) => ({ key: t.key, data: t.data, attempts: t.attempts, enqueuedAt: t.enqueuedAt }));
    return [...parked, ...flying, ...live].slice(-this.maxDepth);
  }

  private persistNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      this.hooks.persistence?.save(this.snapshot());
    } catch {
      // persistence 內部自保；雙重保險不擊倒發送
    }
  }

  private persistSoon(): void {
    if (!this.hooks.persistence) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistNow();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        this.current = task;
        try {
          await this.waitForSlot();
          await this.sendWithRetry(task);
          task.settle();
        } catch (error) {
          task.fail(error);
        } finally {
          this.current = null;
          // 已有定讞（成功或徹底失敗）：parked 的同 key 雙胞胎過期了，一起清掉。
          this.parked = this.parked.filter((t) => t.key !== task.key);
        }
        // 成功／失敗都同步落檔（送完即清）：settled 的任務不會因 crash 重送。
        this.persistNow();
      }
    } finally {
      this.running = false;
    }
  }

  private async waitForSlot(): Promise<void> {
    const sinceLast = Date.now() - this.lastSendAt;
    if (sinceLast < this.getOptions().minIntervalMs) {
      await delay(this.getOptions().minIntervalMs - sinceLast);
    }
  }

  private async sendWithRetry(task: LiveTask<D>): Promise<void> {
    for (;;) {
      try {
        await this.hooks.send(task.data);
        this.lastSendAt = Date.now();
        return;
      } catch (error) {
        const options = this.getOptions();
        if (options.isPermanent(error) || task.attempts >= options.maxRetries) {
          throw error;
        }
        const capped = Math.min(30_000, options.retryBaseMs * 2 ** task.attempts);
        task.attempts += 1;
        this.persistSoon();
        const backoff = Math.round(capped * (0.8 + Math.random() * 0.4));
        await this.waitForSlot();
        await delay(backoff);
      }
    }
  }
}
