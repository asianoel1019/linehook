import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";

const TASK = "polls";
const MAX_POLLS = 5;
const MAX_OPTIONS = 10;

interface PollOption {
  label: string;
}

interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  votes: Record<string, number>;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  closed: boolean;
}

interface PollState {
  polls: Poll[];
}

export type PollCommand =
  | { op: "create"; question: string; options: string[] }
  | { op: "vote"; target: string }
  | { op: "result" }
  | { op: "close" }
  | { op: "list" }
  | { op: "cancel"; target?: string }
  | { op: "help" };

function readPolls(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): Poll[] {
  const state = ctx.taskState(TASK) as Partial<PollState> | undefined;
  return Array.isArray(state?.polls) ? (state.polls as Poll[]) : [];
}

function genId(): string {
  return Date.now().toString(36).slice(-5);
}

function renderResults(poll: Poll): string {
  const total = Object.keys(poll.votes).length;
  const counts = poll.options.map((_, i) => Object.values(poll.votes).filter((v) => v === i).length);
  const max = Math.max(...counts, 1);
  const lines = poll.options.map((opt, i) => {
    const n = counts[i];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    const barLen = Math.round((n / max) * 10);
    const bar = "█".repeat(barLen) + "░".repeat(10 - barLen);
    return `${i + 1}. ${opt.label}  ${bar} ${n} 票 (${pct}%)`;
  });
  const status = poll.closed ? "已結束" : "進行中";
  return `📊 ${poll.question}\n${status} · 共 ${total} 人投票\n${lines.join("\n")}`;
}

/** 解析投票指令（純函式，可測試）。 */
export function parsePollCommand(args: string): PollCommand {
  const cleaned = args.replace(/請幫忙|請幫|幫忙|麻煩|幫我|幫/g, " ").trim();
  if (!cleaned) return { op: "help" };

  if (/^(結果|result|status)$/i.test(cleaned)) return { op: "result" };
  if (/^(結束|close|end|完成)$/i.test(cleaned)) return { op: "close" };
  if (/^(清單|list|列表)$/i.test(cleaned)) return { op: "list" };
  if (/^(說明|help|用法|\?)$/i.test(cleaned)) return { op: "help" };

  const cancel = /^(取消|cancel|delete|刪除|移除)\s*(.+)?$/i.exec(cleaned);
  if (cancel) return { op: "cancel", target: cancel[2]?.trim() || undefined };

  const vote = /^(?:選|投|vote)?\s*(\d{1,2}|[^\s]+)$/i.exec(cleaned);
  if (vote) return { op: "vote", target: vote[1].trim() };

  const create = /^(?:開始|create|new|建立)?\s*(.+)$/i.exec(cleaned);
  if (create) {
    const body = create[1].trim();
    const parts = body.split(/\s*[|｜]\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      return { op: "create", question: parts[0], options: parts.slice(1) };
    }
  }

  return { op: "help" };
}

const pollSkill: SkillDefinition = {
  id: "poll",
  name: "投票",
  description: {
    zh: "在群組中發起投票，收集大家意見。",
    en: "Create polls in group chats to collect opinions.",
    ja: "グループチャットで投票を作成して意見を集めます。",
  },
  usage: {
    zh: "投票 要吃什麼? | 火鍋 | 日料 | 義大利麵\n投票 1（投票給選項 1）\n投票 結果 / 結束 / 清單 / 取消",
    en: "poll What to eat? | Hotpot | Japanese | Pasta\npoll 1 (vote option 1)\npoll result / close / list / cancel",
    ja: "投票 何を食べる? | 火鍋 | 日料 | パスタ\n投票 1（選択肢1に投票）\n投票 結果 / 結束 / 清單 / 取消",
  },
  category: {
    zh: "工具",
    en: "Utilities",
    ja: "ツール",
  },
  defaultTrigger: "投票",
  triggerAliases: ["poll", "表決"],
  fields: [
    { key: "expireDays", label: { zh: "投票過期天數", en: "Expire days", ja: "有効期限（日）" }, hint: "預設 7 天；超過後自動清除", default: "7" },
  ],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "投票", ok: true, detail: "就緒" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const cmd = parsePollCommand(ctx.args);
    const polls = readPolls(ctx);
    const active = polls.filter((p) => !p.closed);
    const save = (updated: Poll[]) => {
      ctx.watch({ task: TASK, everyMinutes: 1440, state: { polls: updated } });
    };

    if (cmd.op === "help") {
      await ctx.reply(
        "用法：\n投票 要吃什麼? | 火鍋 | 日料 | 義大利麵\n投票 1 或 投票 火鍋（投票）\n投票 結果 · 結束 · 清單 · 取消",
      );
      return;
    }

    if (cmd.op === "create") {
      if (cmd.options.length < 2) {
        await ctx.reply("至少需要 2 個選項，用 | 分隔：投票 問題 | 選項1 | 選項2");
        return;
      }
      if (cmd.options.length > MAX_OPTIONS) {
        await ctx.reply(`選項最多 ${MAX_OPTIONS} 個。`);
        return;
      }
      if (active.length >= MAX_POLLS) {
        await ctx.reply(`同時進行的投票最多 ${MAX_POLLS} 個，請先結束舊的。`);
        return;
      }
      const poll: Poll = {
        id: genId(),
        question: cmd.question,
        options: cmd.options.map((label) => ({ label })),
        votes: {},
        createdBy: ctx.fromMid,
        createdByName: ctx.fromName,
        createdAt: Date.now(),
        closed: false,
      };
      const updated = [...polls, poll];
      save(updated);
      logger.info("投票建立", { id: poll.id, question: poll.question, options: cmd.options.length });
      const lines = poll.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
      await ctx.reply(
        `📊 投票已建立（ID: ${poll.id}）\n${poll.question}\n${lines}\n\n回覆「投票 <編號>」投票，或「投票 結果」查看。`,
      );
      return;
    }

    if (cmd.op === "vote") {
      const target = cmd.target;
      const poll = active.length > 0 ? active[active.length - 1] : undefined;
      if (!poll) {
        await ctx.reply("目前沒有進行中的投票。用「投票 問題 | 選項1 | 選項2」建立。");
        return;
      }
      let optionIdx = -1;
      if (/^\d+$/.test(target)) {
        const n = Number(target);
        if (n >= 1 && n <= poll.options.length) optionIdx = n - 1;
      } else {
        optionIdx = poll.options.findIndex((o) => o.label.includes(target) || target.includes(o.label));
      }
      if (optionIdx < 0) {
        const list = poll.options.map((o, i) => `${i + 1}. ${o.label}`).join("、");
        await ctx.reply(`找不到選項「${target}」。可選：${list}`);
        return;
      }
      const had = poll.votes[ctx.fromMid] !== undefined;
      poll.votes[ctx.fromMid] = optionIdx;
      save(polls);
      const count = Object.values(poll.votes).filter((v) => v === optionIdx).length;
      const verb = had ? "已改投" : "已投票";
      await ctx.reply(`${verb}：${poll.options[optionIdx].label}（目前 ${count} 票）`);
      return;
    }

    if (cmd.op === "result") {
      const poll = active.length > 0 ? active[active.length - 1] : undefined;
      if (!poll) {
        await ctx.reply("目前沒有進行中的投票。");
        return;
      }
      await ctx.reply(renderResults(poll));
      return;
    }

    if (cmd.op === "close") {
      const poll = active.length > 0 ? active[active.length - 1] : undefined;
      if (!poll) {
        await ctx.reply("目前沒有進行中的投票。");
        return;
      }
      poll.closed = true;
      save(polls);
      await ctx.reply(`投票已結束：\n${renderResults(poll)}`);
      return;
    }

    if (cmd.op === "list") {
      if (polls.length === 0) {
        await ctx.reply("目前沒有任何投票。用「投票 問題 | 選項1 | 選項2」建立。");
        return;
      }
      const lines = polls.map((p) => {
        const status = p.closed ? "已結束" : "進行中";
        const n = Object.keys(p.votes).length;
        return `${p.id} [${status}] ${p.question}（${n} 票，${p.options.length} 選項）`;
      });
      await ctx.reply(`投票清單：\n${lines.join("\n")}`);
      return;
    }

    if (cmd.op === "cancel") {
      if (polls.length === 0) {
        await ctx.reply("目前沒有任何投票。");
        return;
      }
      const idx = cmd.target
        ? polls.findIndex((p) => p.id === cmd.target || p.question.includes(cmd.target ?? ""))
        : polls.length - 1;
      if (idx < 0) {
        await ctx.reply(`找不到投票「${cmd.target}」，請用「投票 清單」查看。`);
        return;
      }
      const removed = polls[idx];
      polls.splice(idx, 1);
      save(polls);
      await ctx.reply(`已取消投票：${removed.question}`);
      return;
    }
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<PollState>;
    const polls: Poll[] = Array.isArray(state.polls) ? state.polls : [];
    const expireMs = (Number(ctx.config.expireDays) || 7) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const kept = polls.filter((p) => now - p.createdAt < expireMs);
    if (kept.length !== polls.length) {
      await ctx.saveState({ polls: kept });
    }
  },
};

export default pollSkill;
