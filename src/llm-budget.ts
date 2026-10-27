import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { formatInTz } from "./time.js";

/**
 * P0-2 對話級 LLM 用量上限：以 chat × 日為單位的持久化用量帳本＋閘門。
 * metrics counter 是內存且無 chat 維度，重啟就丟、無法回答「這個人今天花了多少」，
 * 所以預算帳本獨立持久化（skill-stats 同款寫法：內存＋5 秒防抖落檔）。
 * CLI 供應商（gemini-cli／opencode-cli）不回 token 數：只計 calls，不參與 token／金額閘門。
 */

export interface ChatDayUsage {
  /** YYYY-MM-DD（config.timezone 牆鐘日）。 */
  date: string;
  promptTokens: number;
  completionTokens: number;
  /** 已定價部分的金額小計；全是未定價模型時為 null。 */
  costUsd: number | null;
  calls: number;
}

export interface ChatUsageToday {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  calls: number;
}

interface LlmBudgetFile {
  chats: Record<string, { days: ChatDayUsage[] }>;
}

const MAX_DAYS = 8;

let overridePath: string | null = null;
/** 測試用：改存檔位置（下次讀寫生效；請同時呼叫 resetLlmBudgetCache 隔離內存）。 */
export function setLlmBudgetPath(path: string | null): void {
  overridePath = path;
}

function filePath(): string {
  if (overridePath) return overridePath;
  return resolve(config.schedulesPath, "..", "llm-budget.json");
}

function blankDay(date: string): ChatDayUsage {
  return { date, promptTokens: 0, completionTokens: 0, costUsd: null, calls: 0 };
}

function normalizeDay(raw: unknown): ChatDayUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ChatDayUsage>;
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  const num = (v: unknown): number => (typeof v === "number" && v >= 0 ? Math.floor(v) : 0);
  return {
    date: r.date,
    promptTokens: num(r.promptTokens),
    completionTokens: num(r.completionTokens),
    costUsd: typeof r.costUsd === "number" && r.costUsd >= 0 ? r.costUsd : null,
    calls: num(r.calls),
  };
}

let cache: LlmBudgetFile | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

function load(): LlmBudgetFile {
  if (cache) return cache;
  try {
    if (!existsSync(filePath())) cache = { chats: {} };
    else {
      const raw = JSON.parse(readFileSync(filePath(), "utf8")) as { chats?: Record<string, unknown> };
      const chats: LlmBudgetFile["chats"] = {};
      if (raw && typeof raw.chats === "object" && raw.chats) {
        for (const [chat, v] of Object.entries(raw.chats)) {
          const days: ChatDayUsage[] = [];
          const list = (v as { days?: unknown })?.days;
          if (Array.isArray(list)) {
            for (const d of list) {
              const day = normalizeDay(d);
              if (day) days.push(day);
            }
            days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
          }
          chats[chat] = { days: days.slice(-MAX_DAYS) };
        }
      }
      cache = { chats };
    }
  } catch (error) {
    logger.warn("讀取 LLM 預算帳本失敗，用空表", { error: String(error) });
    cache = { chats: {} };
  }
  return cache;
}

function saveNow(): void {
  if (!cache) {
    dirty = false;
    return;
  }
  try {
    const path = filePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    logger.warn("儲存 LLM 預算帳本失敗", { error: String(error) });
  }
  dirty = false;
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    saveNow();
  }, 5000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

/** 立刻落檔（測試用；平時由防抖 timer 處理）。 */
export function flushLlmBudget(): void {
  if (!dirty) return;
  saveNow();
}

/** 測試用：丟掉內存＋取消 pending 落檔（換檔隔離）。 */
export function resetLlmBudgetCache(): void {
  cache = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** 記一筆（由 recordLlmUsage 轉交；cost 為 null 代表該模型無定價）。 */
export function recordChatUsage(chat: string, prompt: number, completion: number, cost: number | null): void {
  const store = load();
  const entry = store.chats[chat] ?? { days: [] };
  const today = formatInTz(new Date()).slice(0, 10);
  let day = entry.days.find((d) => d.date === today);
  if (!day) {
    day = blankDay(today);
    entry.days.push(day);
  }
  day.promptTokens += Math.max(0, Math.floor(prompt));
  day.completionTokens += Math.max(0, Math.floor(completion));
  if (cost !== null && cost > 0) day.costUsd = (day.costUsd ?? 0) + cost;
  day.calls += 1;
  entry.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (entry.days.length > MAX_DAYS) entry.days = entry.days.slice(entry.days.length - MAX_DAYS);
  store.chats[chat] = entry;
  scheduleFlush();
}

/** 今天此對話的用量（無紀錄回全零）。 */
export function getChatUsageToday(chat: string): ChatUsageToday {
  const today = formatInTz(new Date()).slice(0, 10);
  const day = load().chats[chat]?.days.find((d) => d.date === today);
  if (!day) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null, calls: 0 };
  return {
    promptTokens: day.promptTokens,
    completionTokens: day.completionTokens,
    totalTokens: day.promptTokens + day.completionTokens,
    costUsd: day.costUsd,
    calls: day.calls,
  };
}

export interface BudgetCheck {
  ok: boolean;
  /** 超限時的回覆文案（直接可回給使用者）。 */
  reason?: string;
  usage: ChatUsageToday;
}

/** 閘門：此對話今日是否還能呼叫（上限 0＝不限）。 */
export function checkChatBudget(chat: string | undefined): BudgetCheck {
  if (!chat) return { ok: true, usage: getChatUsageToday("") };
  const usage = getChatUsageToday(chat);
  const tokCap = config.llmBudgetTokensPerChatDay;
  if (tokCap > 0 && usage.totalTokens >= tokCap) {
    return {
      ok: false,
      usage,
      reason: `本對話今日 LLM 用量已達上限（${usage.totalTokens}/${tokCap} tokens），明天再來，或請管理員調整用量上限`,
    };
  }
  const usdCap = config.llmBudgetUsdPerChatDay;
  if (usdCap > 0 && usage.costUsd !== null && usage.costUsd >= usdCap) {
    return {
      ok: false,
      usage,
      reason: `本對話今日 LLM 花費已達上限（$${usage.costUsd.toFixed(4)}/$${usdCap}），明天再來，或請管理員調整用量上限`,
    };
  }
  return { ok: true, usage };
}
