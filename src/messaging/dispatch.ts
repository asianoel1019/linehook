import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordSend } from "../stats.js";
import { getState } from "../state.js";
import { getSkill } from "../skills/index.js";
import { effectiveMode, skillListText, skillUsageText } from "../skills/help.js";
import type {
  SkillContext,
  SkillTaskContext,
  SkillWatchView,
  WatchOptions,
} from "../skills/types.js";
import type { Job as ScheduledJob, ScheduledJobView } from "../line/scheduler.js";
import type { IncomingMessage, SendInput } from "./types.js";

export type MediaKind = "image" | "video" | "audio" | "file";

/**
 * 各 adapter 向共用分派管線注入的能力。
 * adapter 只需實作傳輸（發送/排程/媒體），指令・技能・轉發規則邏輯共用同一份。
 */
export interface DispatchDeps {
  /** 平台名稱，用於發送統計歸屬（line / telegram…）。 */
  platform: string;
  replyTo(chat: string, text: string): Promise<void>;
  sendAdvanced(inputs: SendInput[]): Promise<void>;
  sendMedia(chat: string, source: string, kind: MediaKind, filename?: string): Promise<void>;
  schedule(inputs: SendInput[], runAt: number, repeat?: string): ScheduledJobView;
  scheduleSkillTask(skillId: string, chat: string, opts: WatchOptions): ScheduledJobView;
  listSkillTasks(filter?: { skillId?: string; chat?: string }): ScheduledJobView[];
  readTaskState(id: string): Record<string, unknown> | undefined;
  saveTaskState(id: string, state: Record<string, unknown>): boolean;
  cancelScheduledTask(id: string): boolean;
  enqueueText(to: string, text: string): Promise<void>;
  getQueueStats(): { pending: number; running: boolean };
  listScheduled(): ScheduledJobView[];
}

/** 收到訊息後的統一管線：指令 → 技能 → 轉發規則。 */
export async function dispatchIncoming(msg: IncomingMessage, deps: DispatchDeps): Promise<void> {
  try {
    if (!msg.chat) return;
    await runCommand(msg.text, msg.chat, msg.fromId, deps);
    await runSkills(msg.text, msg.chat, msg.fromName, msg.fromId, deps);
    await runForwardRules(msg.text, msg.chat, msg.fromName, msg.chatName, deps);
  } catch (error) {
    logger.error("處理收到的訊息失敗", { error: String(error) });
  }
}

/**
 * 技能週期任務觸發分派：找出技能定義並呼叫 onTask。
 * 技能被停用/移除時略過執行（保留排程，重啟技能後恢復）。
 */
export async function dispatchSkillTask(job: ScheduledJob, deps: DispatchDeps): Promise<void> {
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
      deps.saveTaskState(job.id, { ...(ref.state ?? {}), ...patch });
    },
    reply: (t) => deps.replyTo(chat, t),
    sendImage: async (source, filename) => {
      try {
        await deps.sendMedia(chat, source, "image", filename);
        recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: true, platform: deps.platform });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: false, platform: deps.platform });
        throw error;
      }
    },
    sendFile: async (source, filename) => {
      try {
        await deps.sendMedia(chat, source, "file", filename);
        recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: true, platform: deps.platform });
      } catch (error) {
        recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: false, platform: deps.platform });
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

async function runSkills(
  text: string,
  chat: string,
  fromName: string,
  fromMid: string,
  deps: DispatchDeps,
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
    await deps.replyTo(chat, skillListText(config.language));
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
        await deps.replyTo(chat, skillUsageText(def, primaryTrigger, config.language));
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
      const ctx: SkillContext = {
        text,
        args,
        fromName,
        chat,
        fromMid,
        config: skill.config,
        reply: (t) => deps.replyTo(chat, t),
        sendImage: async (source, filename) => {
          try {
            await deps.sendMedia(chat, source, "image", filename);
            recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: true });
          } catch (error) {
            recordSend({ time: new Date().toISOString(), to: chat, type: "image", ok: false });
            throw error;
          }
        },
        sendFile: async (source, filename) => {
          try {
            await deps.sendMedia(chat, source, "file", filename);
            recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: true });
          } catch (error) {
            recordSend({ time: new Date().toISOString(), to: chat, type: "file", ok: false });
            throw error;
          }
        },
        schedule: (text, runAt) => deps.schedule([{ to: chat, text }], runAt).id,
        watch: (opts) => deps.scheduleSkillTask(skillId, chat, opts).id,
        unwatch: (taskOrId) => {
          const jobs = deps.listSkillTasks({ skillId, chat });
          const byId = jobs.find((j) => j.id === taskOrId);
          if (byId) return deps.cancelScheduledTask(byId.id);
          const byTask = jobs.find((j) => j.skillTask?.task === taskOrId);
          if (byTask) return deps.cancelScheduledTask(byTask.id);
          return false;
        },
        watches: () => deps.listSkillTasks({ skillId, chat }).map(toWatchView),
        taskState: (taskOrId) => {
          const jobs = deps.listSkillTasks({ skillId, chat });
          const job =
            jobs.find((j) => j.id === taskOrId) ??
            jobs.find((j) => j.skillTask?.task === taskOrId);
          return job ? deps.readTaskState(job.id) : undefined;
        },
      };
      await def.run(ctx);
    } catch (error) {
      logger.error("技能執行失敗", { skill: skill.id, error: String(error) });
      await deps.replyTo(chat, `技能「${def.name}」執行失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function runForwardRules(
  text: string,
  chat: string,
  fromName: string,
  chatName: string,
  deps: DispatchDeps,
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
      await deps.enqueueText(rule.target, forwarded);
      logger.info("訊息已轉發（規則）", { from: chat, to: rule.target });
    } catch (error) {
      logger.error("轉發規則失敗", { to: rule.target, error: String(error) });
    }
  }
}

async function runCommand(
  text: string,
  chat: string,
  fromMid: string,
  deps: DispatchDeps,
): Promise<void> {
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
      await deps.replyTo(
        chat,
        [
          "可用指令：help、status、send <對象> <訊息>、id",
          `技能清單：${asst}請幫忙`,
          `技能用法：${asst}請幫忙 <觸發詞> ?`,
        ].join("\n"),
      );
    } else if (command === "status") {
      const state = getState();
      const stats = deps.getQueueStats();
      const scheduled = deps.listScheduled();
      const lines = [
        `狀態：${state.status}`,
        `帳號：${state.profileName ?? "-"}`,
        `好友：${state.friendCount ?? 0} / 群組：${state.chatCount ?? 0}`,
        `排程：${scheduled.length}`,
        `佇列：${stats.pending}`,
      ];
      await deps.replyTo(chat, lines.join("\n"));
    } else if (command === "id") {
      await deps.replyTo(chat, `chat=${chat}\nfrom=${fromMid}`);
    } else if (command === "send") {
      const sep = args.indexOf(" ");
      if (sep <= 0) {
        await deps.replyTo(chat, "用法：send <對象> <訊息>");
        return;
      }
      const target = args.slice(0, sep).trim();
      const body = args.slice(sep + 1).trim();
      await deps.sendAdvanced([{ to: target, text: body }]);
      await deps.replyTo(chat, `已發送給 ${target}`);
    } else {
      await deps.replyTo(chat, `未知指令：${command}（可用 help）`);
    }
  } catch (error) {
    logger.error("執行指令失敗", { command, error: String(error) });
    await deps.replyTo(chat, `指令失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}
