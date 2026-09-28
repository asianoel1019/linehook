import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** 技能任務才有（沿用同一排程器持久化與列表）。 */
  skillTask?: {
    skillId: string;
    task: string;
    chat: string;
    args: Record<string, string | number | boolean>;
  };
}

/** 技能週期任務（由 ctx.watch 註冊；onTask 由技能實作）。 */
export interface SkillTaskRef {
  skillId: string;
  task: string;
  chat: string;
  args: Record<string, string | number | boolean>;
  state: Record<string, unknown>;
}

export interface Job {
  id: string;
  runAt: number;
  inputs: SendInput[];
  to: string[];
  summary: string;
  repeat?: string;
  createdAt: number;
  skillTask?: SkillTaskRef;
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
    ...(job.skillTask
      ? {
          skillTask: {
            skillId: job.skillTask.skillId,
            task: job.skillTask.task,
            chat: job.skillTask.chat,
            args: { ...job.skillTask.args },
          },
        }
      : {}),
  };
}

function isValidSkillTask(value: unknown): value is SkillTaskRef {
  const t = value as Partial<SkillTaskRef> | undefined;
  return (
    !!t &&
    typeof t.skillId === "string" &&
    typeof t.task === "string" &&
    typeof t.chat === "string" &&
    (!("args" in (t as object)) || (typeof t.args === "object" && t.args !== null)) &&
    (!("state" in (t as object)) || (typeof t.state === "object" && t.state !== null))
  );
}

export class SendScheduler {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly path = config.schedulesPath;

  constructor(
    private readonly execute: (inputs: SendInput[]) => Promise<void>,
    private readonly onSkillTask?: (job: Job) => Promise<void>,
  ) {
    this.load();
  }

  add(inputs: SendInput[], runAt: number, repeat?: string, skillTask?: SkillTaskRef): ScheduledJobView {
    if (repeat) {
      const cron = parseCron(repeat);
      if (nextRun(cron, Date.now(), config.timezone) === null) {
        throw new Error("無效的排程：一年內無符合時間");
      }
    }
    if (skillTask && !repeat) {
      throw new Error("技能任務需指定 repeat（cron）");
    }
    const job: Job = {
      id: randomUUID(),
      runAt,
      inputs,
      to: skillTask ? [skillTask.chat] : inputs.map((input) => input.to),
      summary: skillTask ? `技能任務：${skillTask.skillId}/${skillTask.task}` : summarize(inputs),
      repeat: repeat || undefined,
      createdAt: Date.now(),
      ...(skillTask
        ? {
            skillTask: {
              skillId: skillTask.skillId,
              task: skillTask.task,
              chat: skillTask.chat,
              args: { ...skillTask.args },
              state: { ...(skillTask.state ?? {}) },
            },
          }
        : {}),
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
      if (patch.repeat) {
        const cron = parseCron(patch.repeat);
        if (nextRun(cron, Date.now(), config.timezone) === null) {
          throw new Error("無效的排程：一年內無符合時間");
        }
      }
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

  /** 依 id 取內部任務（含 skillTask state；回傳副本）。 */
  getSkillTask(id: string): SkillTaskRef | undefined {
    const job = this.jobs.find((item) => item.id === id);
    const ref = job?.skillTask;
    if (!ref) return undefined;
    return { ...ref, args: { ...ref.args }, state: { ...(ref.state ?? {}) } };
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
    // 只解除計時器並停止觸發；不清空 jobs，避免重啟/關閉時丟失持久化排程。
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 更新技能任務的 state 並持久化；找不到回 false。 */
  saveSkillState(id: string, state: Record<string, unknown>): boolean {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !job.skillTask) return false;
    job.skillTask.state = { ...state };
    this.save();
    return true;
  }

  /** 更新技能任務的 args 並持久化；找不到回 false。 */
  saveSkillArgs(id: string, args: Record<string, string | number | boolean>): boolean {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !job.skillTask) return false;
    job.skillTask.args = { ...args };
    this.save();
    return true;
  }

  private loadFile(path: string): Job[] | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Job[];
      if (!Array.isArray(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let raw = this.loadFile(this.path);
    if (!raw) {
      logger.warn("排程檔損毀，嘗試讀取備份", { path: this.path });
      raw = this.loadFile(`${this.path}.bak`);
    }
    if (!raw) {
      logger.warn("載入排程失敗（主檔與備份皆無法解析），保留空排程避免誤刪", { path: this.path });
      return;
    }
    try {
      const now = Date.now();
      const before = raw.length;
      this.jobs = raw.filter((job) => {
        if (!job || typeof job.id !== "string") return false;
        if (job.skillTask) {
          if (!isValidSkillTask(job.skillTask)) return false;
          if (job.repeat) {
            try {
              parseCron(job.repeat);
              return true;
            } catch {
              return false;
            }
          }
          return typeof job.runAt === "number" && job.runAt > now - 60_000;
        }
        if (!Array.isArray(job.inputs)) return false;
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
      const dropped = before - this.jobs.length;
      if (dropped > 0) logger.warn("啟動時丟棄過期/無效排程", { path: this.path, dropped });
      logger.info("已載入排程", { path: this.path, count: this.jobs.length });
      this.arm();
    } catch (error) {
      logger.warn("載入排程失敗", { error: String(error) });
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.jobs, null, 2), "utf8");
      renameSync(tmp, this.path);
      try {
        copyFileSync(this.path, `${this.path}.bak`);
      } catch {
        // 備份失敗不影響主檔
      }
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
        if (job.skillTask) {
          if (this.onSkillTask) {
            await this.onSkillTask(job);
          } else {
            logger.warn("技能任務無處理器，略過執行", { id: job.id });
          }
        } else {
          await this.execute(job.inputs);
          logger.info("排程訊息已送出", { id: job.id, to: job.to });
        }
      } catch (error) {
        logger.error("排程執行失敗", {
          id: job.id,
          to: job.to,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 執行期間可能被更新/取消，重新找一次才變更，避免覆蓋別人的修改。
      const current = this.jobs.find((item) => item.id === job.id);
      if (!current) continue;
      if (current.repeat) {
        try {
          const cron = parseCron(current.repeat);
          const next = nextRun(cron, Date.now(), config.timezone);
          if (next) current.runAt = next;
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
