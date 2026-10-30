import type { SkillContext, SkillDefinition, SkillTaskContext, SkillWatchView, WatchOptions } from "./types.js";

/**
 * P2 技能測試輔助套件：外部作者 5 行就能寫出第一支測試。
 * createSkillHarness() 給你帶收集功能的 ctx（回覆／圖片／排程／watch／state）。
 */

export interface HarnessOptions {
  /** 技能設定（ctx.config）。 */
  config?: Record<string, string>;
  /** 對話／目標 id。 */
  chat?: string;
  /** 寄件者 id。 */
  fromMid?: string;
  /** 寄件者名稱。 */
  fromName?: string;
  /** 已存在的 watch（模擬已註冊的週期任務）。 */
  watches?: SkillWatchView[];
  /** 初始任務 state。 */
  state?: Record<string, unknown>;
  /** 允許技能使用的能力（預設全開）。 */
  allow?: {
    reply?: boolean;
    media?: boolean;
    schedule?: boolean;
    watch?: boolean;
  };
}

export interface Harness {
  /** 交給技能 run() 的 ctx。 */
  ctx: SkillContext;
  /** 技能回覆的文字（依序）。 */
  replies: string[];
  /** 技能送出的圖片／檔案。 */
  media: Array<{ kind: "image" | "file"; source: string; filename?: string }>;
  /** 技能排程的訊息（runAt 與內容）。 */
  schedules: Array<{ text: string; runAt: number }>;
  /** 技能註冊的 watch（task 名稱與選項）。 */
  watched: Array<{ task: string; opts: WatchOptions }>;
  /** 技能讀寫的任務 state（最新值）。 */
  state: Record<string, unknown>;
  /** 完整跑一次技能（回傳技能自己丟出的錯誤）。 */
  run(def: SkillDefinition, text: string): Promise<void>;
  /** 以指定的 skillId 跑（def.id 為準則忽略 skillId）。 */
  runAs(def: SkillDefinition, skillId: string, text: string): Promise<void>;
  /** 一次性任務 ctx（測 onTask 用）。 */
  taskCtx(overrides?: Partial<SkillTaskContext>): SkillTaskContext;
}

function noop(): void {
  // 預設不做的動作（測試通常不需要真的排程）。
}

/** 建立測試 harness。 */
export function createSkillHarness(options: HarnessOptions = {}): Harness {
  const allow = {
    reply: options.allow?.reply !== false,
    media: options.allow?.media !== false,
    schedule: options.allow?.schedule !== false,
    watch: options.allow?.watch !== false,
  };
  const replies: string[] = [];
  const media: Harness["media"] = [];
  const schedules: Harness["schedules"] = [];
  const watched: Harness["watched"] = [];
  const state: Record<string, unknown> = { ...(options.state ?? {}) };
  const watchList: SkillWatchView[] = [...(options.watches ?? [])];

  const ctx: SkillContext = {
    text: "",
    args: "",
    fromName: options.fromName ?? "測試者",
    chat: options.chat ?? "test-chat",
    fromMid: options.fromMid ?? "test-mid",
    config: options.config ?? {},
    reply: async (text: string) => {
      if (!allow.reply) return;
      replies.push(text);
    },
    sendImage: async (source: string, filename?: string) => {
      if (!allow.media) return;
      media.push({ kind: "image", source, ...(filename ? { filename } : {}) });
    },
    sendFile: async (source: string, filename?: string) => {
      if (!allow.media) return;
      media.push({ kind: "file", source, ...(filename ? { filename } : {}) });
    },
    schedule: (text: string, runAt: number) => {
      if (allow.schedule) schedules.push({ text, runAt });
      return `harness-sched-${schedules.length}`;
    },
    watch: (opts: WatchOptions) => {
      if (allow.watch) watched.push({ task: opts.task, opts });
      const id = `harness-watch-${watched.length}`;
      watchList.push({
        id,
        task: opts.task,
        cron: opts.cron ?? opts.at ?? "",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        args: opts.args ?? {},
      });
      return id;
    },
    unwatch: (taskOrId: string) => {
      const idx = watchList.findIndex((w) => w.id === taskOrId || w.task === taskOrId);
      if (idx < 0) return false;
      watchList.splice(idx, 1);
      return true;
    },
    watches: () => watchList.map((w) => ({ ...w })),
    taskState: (taskOrId: string) => {
      const found = watchList.find((w) => w.id === taskOrId || w.task === taskOrId);
      return found ? state : undefined;
    },
  };

  const harness: Harness = {
    ctx,
    replies,
    media,
    schedules,
    watched,
    state,
    run: async (def: SkillDefinition, text: string) => {
      ctx.text = text;
      ctx.args = text;
      await def.run(ctx);
    },
    runAs: async (def: SkillDefinition, skillId: string, text: string) => {
      ctx.text = text;
      ctx.args = text;
      ctx.config = { ...(options.config ?? {}), __skillId: skillId };
      await def.run(ctx);
    },
    taskCtx: (overrides = {}) => ({
      taskId: "harness-task",
      task: "harness",
      chat: options.chat ?? "test-chat",
      fromName: options.fromName ?? "測試者",
      config: options.config ?? {},
      args: {},
      state: { ...state },
      saveState: async (patch: Record<string, unknown>) => {
        Object.assign(state, patch);
      },
      reply: async (text: string) => {
        if (!allow.reply) return;
        replies.push(text);
      },
      sendImage: async (source: string, filename?: string) => {
        if (!allow.media) return;
        media.push({ kind: "image", source, ...(filename ? { filename } : {}) });
      },
      sendFile: async (source: string, filename?: string) => {
        if (!allow.media) return;
        media.push({ kind: "file", source, ...(filename ? { filename } : {}) });
      },
      ...overrides,
    }),
  };
  void noop;
  return harness;
}
