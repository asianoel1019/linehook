import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSkill } from "../skills/index.js";
import { getService } from "./services.js";
import { recordSkillRun } from "../skill-stats.js";
import { recordMetric } from "../metrics.js";
import type { SkillContext, SkillTaskContext, SkillWatchView } from "../skills/types.js";
import type { Platform, SendInput } from "./types.js";

/**
 * P3 hook 觸發技能：外部專案的事件 → 直接跑某支技能 → 用技能的輸出推播。
 * 不經觸發詞比對（hook 已經指名要跑哪支），技能拿到的是渲染後的參數。
 * 回覆走平台的 sendAdvanced（佇列落盤、備援、死信都照常）。
 */

export interface HookSkillResult {
  ok: boolean;
  error?: string;
  /** 技能送出的訊息數。 */
  messages: number;
  skill: string;
}

export interface HookSkillOptions {
  skillId: string;
  args: string;
  /** 目標對話（名稱或 id；由 adapter 的 resolveTarget 解析）。 */
  chat: string;
  platform: Platform;
}

/**
 * 以 hook 事件觸發技能並投遞其回覆。
 * skill 不存在／停用 → 回失敗（呼叫端看得到原因）。
 */
export async function runHookSkill(opts: HookSkillOptions): Promise<HookSkillResult> {
  const skillId = opts.skillId.trim();
  const def = getSkill(skillId);
  if (!def) {
    return { ok: false, error: `找不到技能：${skillId}`, messages: 0, skill: skillId };
  }
  const entry = config.skills.find((s) => s.id === skillId);
  if (!entry?.enabled) {
    return { ok: false, error: `技能未啟用：${skillId}`, messages: 0, skill: skillId };
  }
  const svc = getService(opts.platform);
  if (!svc) {
    return { ok: false, error: `平台未啟用：${opts.platform}`, messages: 0, skill: skillId };
  }
  let messages = 0;
  const chat = opts.chat;
  const skillConfig = entry.config ?? {};
  const send = async (input: Omit<SendInput, "to">): Promise<void> => {
    await svc.sendAdvanced([{ to: chat, ...input }]);
    messages += 1;
  };
  const ctx: SkillContext = {
    text: opts.args,
    args: opts.args,
    fromName: "hook",
    chat,
    fromMid: "",
    config: skillConfig,
    reply: async (text: string) => {
      if (!text) return;
      await send({ text });
    },
    sendImage: async (source: string, filename?: string) => {
      await send({ image: source, ...(filename ? { filename } : {}) });
    },
    sendFile: async (source: string, filename?: string) => {
      await send({ file: source, ...(filename ? { filename } : {}) });
    },
    // hook 觸發的技能可以排程（會落盤）。
    schedule: (text: string, runAt: number) => {
      const job = svc.schedule([{ to: chat, text }], runAt);
      messages += 1;
      return job.id;
    },
    // 週期任務（watch）需要技能任務排程器，hook 事件沒有對話任務脈絡 → 明確拒絕而不是靜默。
    watch: () => {
      throw new Error("hook 觸發的技能不支援週期任務（watch）");
    },
    unwatch: () => false,
    watches: () => [] as SkillWatchView[],
    taskState: () => undefined,
  };
  const startedAt = Date.now();
  try {
    await def.run(ctx);
    recordMetric("hook_skill_runs_total", 1, { skill: skillId, result: "ok" });
    recordSkillRun(skillId, true);
    logger.info("hook 觸發技能完成", { skill: skillId, chat, messages, ms: Date.now() - startedAt });
    return { ok: true, messages, skill: skillId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordMetric("hook_skill_runs_total", 1, { skill: skillId, result: "fail" });
    recordSkillRun(skillId, false, message);
    logger.error("hook 觸發技能失敗", { skill: skillId, chat, error: message });
    return { ok: false, error: message, messages, skill: skillId };
  }
}

/** 任務型 ctx（給需要 SkillTaskContext 的技能；hook 場景通常用不到）。 */
export function hookTaskCtx(chat: string, args: Record<string, string | number | boolean>): SkillTaskContext {
  return {
    taskId: "hook",
    task: "hook",
    chat,
    fromName: "hook",
    config: {},
    args,
    state: {},
    saveState: async () => {},
    reply: async () => {},
    sendImage: async () => {},
    sendFile: async () => {},
  };
}
