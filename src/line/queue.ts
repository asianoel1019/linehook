export interface SendQueueOptions {
  maxRetries: number;
  retryBaseMs: number;
  minIntervalMs: number;
  isPermanent: (error: unknown) => boolean;
}

interface Task {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SendQueue {
  private readonly queue: Task[] = [];
  private running = false;
  private stopped = false;
  private lastSendAt = 0;

  constructor(private readonly getOptions: () => SendQueueOptions) {}

  enqueue(run: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("發送佇列已停止"));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      void this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    for (const task of this.queue.splice(0)) {
      task.reject(new Error("發送佇列已停止"));
    }
  }

  stats(): { pending: number; running: boolean } {
    return { pending: this.queue.length, running: this.running };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        try {
          await this.waitForSlot();
          await this.sendWithRetry(task.run);
          task.resolve();
        } catch (error) {
          task.reject(error);
        }
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

  private async sendWithRetry(run: () => Promise<void>): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await run();
        this.lastSendAt = Date.now();
        return;
      } catch (error) {
        const options = this.getOptions();
        if (options.isPermanent(error) || attempt >= options.maxRetries) {
          throw error;
        }
        const backoff = options.retryBaseMs * 2 ** attempt;
        attempt += 1;
        await delay(backoff);
      }
    }
  }
}
