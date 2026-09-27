import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { nextRun, parseCron } from "./cron.js";
import type { SendInput } from "./client.js";

export interface ScheduledJobView {
  id: string;
  runAt: string;
  to: string[];
  summary: string;
  repeat?: string;
  recurring: boolean;
}

interface Job {
  id: string;
  runAt: number;
  inputs: SendInput[];
  to: string[];
  summary: string;
  repeat?: string;
  createdAt: number;
}

// setTimeout 上限約 24.8 天；超過就先分段喚醒，時間到再處理。
const MAX_WAIT_MS = 2_000_000_000;

function summarize(inputs: SendInput[]): string {
  const first = inputs[0];
  if (!first) return "";
  const parts: string[] = [];
  if (first.text) parts.push(`text:${first.text.slice(0, 24)}`);
  if (first.image) parts.push("image");
  if (first.video) parts.push("video");
  if (first.audio) parts.push("audio");
  if (first.file) parts.push("file");
  if (first.sticker) parts.push("sticker");
  if (first.location) parts.push("location");
  if (first.flex) parts.push("flex");
  const extra = inputs.length > 1 ? `（共 ${inputs.length} 則）` : "";
  return parts.join(", ") + extra;
}

function toView(job: Job): ScheduledJobView {
  return {
    id: job.id,
    runAt: new Date(job.runAt).toISOString(),
    to: job.to,
    summary: job.summary,
    repeat: job.repeat,
    recurring: Boolean(job.repeat),
  };
}

export class SendScheduler {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly path = config.schedulesPath;

  constructor(private readonly execute: (inputs: SendInput[]) => Promise<void>) {
    this.load();
  }

  add(inputs: SendInput[], runAt: number, repeat?: string): ScheduledJobView {
    if (repeat) parseCron(repeat);
    const job: Job = {
      id: randomUUID(),
      runAt,
      inputs,
      to: inputs.map((input) => input.to),
      summary: summarize(inputs),
      repeat: repeat || undefined,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this.save();
    logger.info("已排程訊息", { id: job.id, runAt: job.runAt, to: job.to, repeat: job.repeat });
    this.arm();
    return toView(job);
  }

  update(
    id: string,
    patch: { runAt?: number; repeat?: string | null },
  ): ScheduledJobView | null {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return null;
    if (patch.repeat !== undefined) {
      if (patch.repeat) parseCron(patch.repeat);
      job.repeat = patch.repeat || undefined;
    }
    if (patch.runAt !== undefined) job.runAt = patch.runAt;
    this.save();
    logger.info("已更新排程", { id, runAt: job.runAt, repeat: job.repeat });
    this.arm();
    return toView(job);
  }

  list(): ScheduledJobView[] {
    return [...this.jobs].sort((a, b) => a.runAt - b.runAt).map(toView);
  }

  cancel(id: string): boolean {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    this.jobs.splice(index, 1);
    this.save();
    logger.info("已取消排程訊息", { id });
    this.arm();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.jobs = [];
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Job[];
      if (!Array.isArray(raw)) return;
      const now = Date.now();
      this.jobs = raw.filter((job) => {
        if (!job || typeof job.id !== "string" || !Array.isArray(job.inputs)) return false;
        if (job.repeat) {
          try {
            parseCron(job.repeat);
            return true;
          } catch {
            return false;
          }
        }
        return typeof job.runAt === "number" && job.runAt > now - 60_000;
      });
      logger.info("已載入排程", { path: this.path, count: this.jobs.length });
      this.arm();
    } catch (error) {
      logger.warn("載入排程失敗", { error: String(error) });
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.jobs, null, 2), "utf8");
    } catch (error) {
      logger.warn("儲存排程失敗", { error: String(error) });
    }
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.jobs.length === 0) return;

    const next = Math.min(...this.jobs.map((job) => job.runAt));
    const wait = Math.max(0, Math.min(next - Date.now(), MAX_WAIT_MS));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, wait);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const due = this.jobs.filter((job) => job.runAt <= now);

    for (const job of due) {
      try {
        await this.execute(job.inputs);
        logger.info("排程訊息已送出", { id: job.id, to: job.to });
      } catch (error) {
        logger.error("排程訊息發送失敗", {
          id: job.id,
          to: job.to,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (job.repeat) {
        try {
          const cron = parseCron(job.repeat);
          const next = nextRun(cron, Date.now());
          if (next) job.runAt = next;
          else this.jobs = this.jobs.filter((item) => item.id !== job.id);
        } catch {
          this.jobs = this.jobs.filter((item) => item.id !== job.id);
        }
      } else {
        this.jobs = this.jobs.filter((item) => item.id !== job.id);
      }
    }

    this.save();
    this.arm();
  }
}
