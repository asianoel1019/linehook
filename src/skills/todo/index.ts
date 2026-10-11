import { logger } from "../../logger.js";
import type { SkillContext, SkillDefinition, SkillHealth, SkillTaskContext } from "../types.js";

const TASK = "list";
const MAX_ITEMS = 50;
/** 已完成項目保留天數（逾時由 onTask 清掉）。 */
const DONE_KEEP_DAYS = 7;

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  by: string;
  createdAt: number;
  doneAt?: number;
}

interface TodoState {
  items: TodoItem[];
  seq: number;
}

function readItems(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): TodoItem[] {
  const state = ctx.taskState(TASK) as Partial<TodoState> | undefined;
  return Array.isArray(state?.items) ? (state.items as TodoItem[]) : [];
}

function readSeq(ctx: { taskState: (t: string) => Record<string, unknown> | undefined }): number {
  const state = ctx.taskState(TASK) as Partial<TodoState> | undefined;
  return typeof state?.seq === "number" ? state.seq : 0;
}

export function renderList(items: TodoItem[]): string {
  return items.map((it, i) => `${i + 1}. ${it.done ? "☑" : "▫"} ${it.text}${it.done ? "（完成）" : ""}`).join("\n");
}

/** 依照「未完成優先、同組新的在前」排序。 */
export function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.createdAt - a.createdAt;
  });
}

/** 解析要操作的編號清單（"2"、"2,3"、"全部"）；無效或空回 null。 */
export function parseIndices(raw: string, total: number): number[] | null {
  const t = raw.trim();
  if (!t) return null;
  if (/全部|所有/.test(t)) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of t.split(/[,，、\s]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > total) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : null;
}

const todoSkill: SkillDefinition = {
  id: "todo",
  name: "待辦清單",
  description: {
    zh: "每組對話獨立的待辦清單：新增、完成、刪除。",
    en: "Per-chat todo list: add, complete, and delete items.",
    ja: "会話ごとの ToDo リスト：追加・完了・削除。",
  },
  usage: {
    zh: "待辦 買牛奶；待辦 完成 1；待辦 清單；待辦 刪除 2；待辦 清除已完成",
    en: "todo buy milk; todo done 1; todo list; todo delete 2; todo clear-done",
    ja: "やること 牛乳を買う；やること 完了 1；やること 一覧；やること 削除 2；やること 完了を消去",
  },
  category: { zh: "工具", en: "Utilities", ja: "ツール" },
  defaultTrigger: "待辦",
  triggerAliases: ["todo", "待辦事項", "事項", "清單"],
  fields: [{ key: "maxItems", label: { zh: "項目上限", en: "Max items", ja: "最大件数" }, hint: "預設 50；1–200" }],
  async health(): Promise<SkillHealth[]> {
    return [{ name: "待辦清單", ok: true, detail: "就緒（資料隨對話保存）" }];
  },
  async run(ctx: SkillContext): Promise<void> {
    const raw = ctx.args.replace(/請幫忙|請幫|幫忙|的|麻煩/g, " ").trim();
    const items = sortItems(readItems(ctx));
    const max = Math.min(Math.max(Number(ctx.config.maxItems) || MAX_ITEMS, 1), 200);

    const save = (updated: TodoItem[], seq: number): void => {
      ctx.watch({ task: TASK, everyMinutes: 1440, state: { items: updated, seq } });
    };

    // 清單
    if (/^(清單|列表|list|全部待辦)$/i.test(raw) || raw === "") {
      if (items.length === 0) {
        await ctx.reply("目前沒有待辦事項。\n用法：待辦 買牛奶、雞蛋");
        return;
      }
      const open = items.filter((i) => !i.done).length;
      const done = items.length - open;
      await ctx.reply(`待辦清單（未完成 ${open}・已完成 ${done}）：\n${renderList(items)}`);
      return;
    }

    // 完成／刪除／清除
    if (/^(完成|做好|done|勾|勾選)/i.test(raw)) {
      const rest = raw.replace(/^(完成|做好|done|勾|勾選)/i, "");
      const idx = parseIndices(rest, items.length);
      if (!idx) {
        await ctx.reply(`用法：待辦 完成 1（或 完成 1,2、完成 全部）\n目前共 ${items.length} 項。`);
        return;
      }
      let n = 0;
      for (const i of idx) {
        const it = items[i - 1];
        if (it && !it.done) {
          it.done = true;
          it.doneAt = Date.now();
          n++;
        }
      }
      if (n === 0) {
        await ctx.reply("選取的項目都已經是完成狀態。");
        return;
      }
      const sorted = sortItems(items);
      save(sorted, readSeq(ctx));
      const open = sorted.filter((i) => !i.done).length;
      await ctx.reply(`☑ 已完成 ${n} 項，剩未完成 ${open} 項。`);
      return;
    }

    if (/^(刪除|刪掉|delete|del|移除|取消)/i.test(raw)) {
      const rest = raw.replace(/^(刪除|刪掉|delete|del|移除|取消)/i, "");
      const idx = parseIndices(rest, items.length);
      if (!idx) {
        await ctx.reply(`用法：待辦 刪除 1（或 刪除 1,2）`);
        return;
      }
      const removed: string[] = [];
      for (const i of idx.sort((a, b) => b - a)) {
        const it = items[i - 1];
        if (it) {
          removed.push(it.text);
          items.splice(i - 1, 1);
        }
      }
      save(items, readSeq(ctx));
      await ctx.reply(`已刪除：${removed.join("、")}`);
      return;
    }

    if (/^(清除已完成|清除完成|清掉已完成|clear)/i.test(raw)) {
      const kept = items.filter((i) => !i.done);
      const n = items.length - kept.length;
      if (n === 0) {
        await ctx.reply("目前沒有已完成的項目。");
        return;
      }
      save(kept, readSeq(ctx));
      await ctx.reply(`已清除 ${n} 個已完成項目，剩 ${kept.length} 項。`);
      return;
    }

    // 純編號 = 切換完成狀態（「待辦 2」→ 第 2 項打勾／取消打勾）
    if (/^\d+([,，、\s]+\d+)*$/.test(raw)) {
      const idx = parseIndices(raw, items.length);
      if (!idx) {
        await ctx.reply(`沒有第 ${raw} 項，目前共 ${items.length} 項。`);
        return;
      }
      let done = 0;
      let undone = 0;
      for (const i of idx) {
        const it = items[i - 1];
        if (!it) continue;
        if (it.done) {
          it.done = false;
          it.doneAt = undefined;
          undone++;
        } else {
          it.done = true;
          it.doneAt = Date.now();
          done++;
        }
      }
      if (done === 0 && undone === 0) {
        await ctx.reply("沒有可切換的項目。");
        return;
      }
      const sorted = sortItems(items);
      save(sorted, readSeq(ctx));
      const parts: string[] = [];
      if (done > 0) parts.push(`完成 ${done} 項`);
      if (undone > 0) parts.push(`取消完成 ${undone} 項`);
      await ctx.reply(`${parts.join("、")}，未完成 ${sorted.filter((i) => !i.done).length} 項。`);
      return;
    }

    // 加入
    const texts = raw
      .split(/[、,，;；\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (texts.length === 0) {
      await ctx.reply("用法：待辦 買牛奶、雞蛋");
      return;
    }
    const fresh: TodoItem[] = [];
    const now = Date.now();
    let seq = readSeq(ctx);
    for (const text of texts.slice(0, 10)) {
      if (items.length + fresh.length >= max) break;
      if (items.some((i) => i.text === text) || fresh.some((i) => i.text === text)) continue;
      seq += 1;
      fresh.push({ id: seq, text, done: false, by: ctx.fromName, createdAt: now });
    }
    if (fresh.length === 0) {
      await ctx.reply(items.length >= max ? `待辦已達上限（${max} 項），請先刪除舊的。` : "這些事項都已經在清單裡了。");
      return;
    }
    const updated = sortItems([...items, ...fresh]);
    save(updated, seq);
    const names = fresh.map((i) => i.text).join("、");
    const open = updated.filter((i) => !i.done).length;
    logger.info("待辦新增", { chat: ctx.chat, count: fresh.length });
    await ctx.reply(`☑ 已加入 ${fresh.length} 項：${names}\n未完成 ${open} 項。`);
  },
  async onTask(ctx: SkillTaskContext): Promise<void> {
    const state = ctx.state as Partial<TodoState>;
    const items: TodoItem[] = Array.isArray(state.items) ? state.items : [];
    if (items.length === 0) return;
    const cutoff = Date.now() - DONE_KEEP_DAYS * 86_400_000;
    const kept = items.filter((it) => !it.done || (it.doneAt ?? 0) > cutoff);
    if (kept.length !== items.length) {
      const seq = Math.max(...items.map((i) => i.id ?? 0), 0);
      await ctx.saveState({ items: kept, seq });
    }
  },
};

export default todoSkill;
