import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordSend } from "../stats.js";
import { getState } from "../state.js";
import { getSkill } from "../skills/index.js";
import { effectiveMode, skillListText, skillUsageText } from "../skills/help.js";
import type { SkillContext, SkillTaskContext, SkillWatchView, WatchOptions } from "../skills/types.js";
import type { Job as ScheduledJob, ScheduledJobView } from "../line/scheduler.js";
import type { IncomingMessage, Platform, SendInput } from "./types.js";
import type { IncomingImage, IncomingLocation } from "./types.js";
import { seenInbound } from "./dedup.js";
import { getService } from "./services.js";
import { extractLocationFromText } from "./location.js";
import { conversionArgs, parseConversion } from "../skills/exchange-rate/index.js";
import { parseCryptoConversion } from "../skills/crypto/index.js";
import { parseFlightIntent, parseFlightNo } from "../skills/flight-status/index.js";
import { classifyIntent, collectRouterCandidates, routerAvailable } from "./intent-router.js";
import { nowInTz, zonedTimeToMs } from "../time.js";
import {
  loadSchedulesMeta,
  recordLastRun,
} from "../schedules-meta.js";

/** 無前綴自然意圖門檻（分數＝命中關鍵字去重後長度加總；群組更嚴）。 */
export const NATURAL_INTENT_THRESHOLD = 4;
export const NATURAL_INTENT_THRESHOLD_GROUP = 6;

/**
 * 計算單一技能的自然意圖分數（大小寫不敏感）。
 * 同一關鍵字只計一次；已被更長關鍵字涵蓋的片段不重複計分
 * （「台積電」同時含「台積」時只算 3 分，避免別名灌水）。
 */
export function scoreNaturalIntent(text: string, keywords: string[] | undefined): number {
  if (!keywords || keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  const sorted = [...new Set(keywords.filter(Boolean).map((k) => k.toLowerCase()))].sort(
    (a, b) => b.length - a.length,
  );
  const used: Array<{ s: number; e: number }> = [];
  let score = 0;
  for (const key of sorted) {
    let idx = lower.indexOf(key);
    while (idx >= 0) {
      const s = idx;
      const e = idx + key.length;
      if (!used.some((u) => s < u.e && e > u.s)) {
        used.push({ s, e });
        score += key.length;
        break;
      }
      idx = lower.indexOf(key, idx + 1);
    }
  }
  return score;
}

/**
 * 無前綴自然意圖路由（「台北天氣如何」→ 天氣）。
 * 只考慮啟用＋白名單通過＋有 naturalKeywords 的技能；最高分同分、未達門檻都回 null。
 */
export function findNaturalIntent(
  text: string,
  chat: string,
  fromMid: string,
  platform: string,
): SkillConfig | null {
  let best: SkillConfig | null = null;
  let bestScore = 0;
  let tied = false;
  for (const entry of config.skills) {
    if (!entry.enabled) continue;
    const allowed = entry.allowedUsers ?? [];
    if (allowed.length > 0 && !allowed.includes(fromMid) && !allowed.includes(chat)) continue;
    const def = getSkill(entry.id);
    const score = scoreNaturalIntent(text, def?.naturalKeywords);
    if (score <= 0) continue;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  const need = isGroupChat(platform, chat) ? NATURAL_INTENT_THRESHOLD_GROUP : NATURAL_INTENT_THRESHOLD;
  return bestScore >= need ? best : null;
}
import { writeDeadLetter } from "../deadletter.js";
import { recordMetric, recordDuration, classifySkillError } from "../metrics.js";
import { recordSkillRun } from "../skill-stats.js";
import type { SkillConfig } from "../config.js";
import type { SkillDefinition } from "../skills/types.js";
import type { ForwardRule } from "../config.js";
import {
  aiGroupModeOn,
  aiModeTtlMs,
  clearAiMode,
  consumeExpiredAiMode,
  detectAiModeCommand,
  isAiModeActive,
  isGroupChat,
  touchAiMode,
} from "../skills/ai/mode.js";

/** per-skill 限流（F5）：預設每對話每分鐘 60 次；花錢/打外部 API 的技能更嚴。 */
export const SKILL_RATE_LIMIT_DEFAULT = 60;
export const SKILL_RATE_LIMIT_STRICT: Record<string, number> = {
  ai: 30,
  summarize: 30,
  flight: 30,
  translate: 30,
};
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 5000;
const skillHits = new Map<string, number[]>();

function skillThrottled(skillId: string, chat: string): boolean {
  const limit = SKILL_RATE_LIMIT_STRICT[skillId] ?? SKILL_RATE_LIMIT_DEFAULT;
  const key = `${skillId}:${chat}`;
  const now = Date.now();
  const times = (skillHits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= limit) {
    skillHits.set(key, times);
    return true;
  }
  times.push(now);
  skillHits.set(key, times);
  if (skillHits.size > MAX_BUCKETS) {
    const oldest = skillHits.keys().next();
    if (!oldest.done) skillHits.delete(oldest.value);
  }
  return false;
}

/** 唯讀版限流檢查（規則模擬器用）：只報當下是否已超額，不累計。 */
export function isSkillThrottledNow(skillId: string, chat: string): boolean {
  const limit = SKILL_RATE_LIMIT_STRICT[skillId] ?? SKILL_RATE_LIMIT_DEFAULT;
  const now = Date.now();
  const times = (skillHits.get(`${skillId}:${chat}`) ?? []).filter((t) => now - t < WINDOW_MS);
  return times.length >= limit;
}

/* ── 以下為「比對」純函式：真實管線與規則模擬器（src/messaging/simulate.ts）共用， ──
   ── 以確保模擬結果與實際行為不會 drifting。純函式不讀 msg 以外的外部狀態（config 由呼叫端傳入）。 */

export interface AssistantPrefix {
  /** 設定中的助理名稱（已 trim）。 */
  assistant: string;
  /** 助理名稱與禮貌詞之後的剩餘文字。 */
  rest: string;
  hasPrefix: boolean;
}

/** 依語言決定禮貌詞（H1：非中文部署下否則助理模式會完全失靈）。 */
function politePattern(language: string): RegExp {
  if (language === "en") return /^(please|pls|help|help me|kindly)\s*/i;
  if (language === "ja") return /^(お願い|おねがい|助けて|ヘルプ|ください)\s*/;
  return /^(請幫忙|請幫|幫忙|麻煩|幫我|幫)\s*/;
}

/** 解析助理前綴：訊息是否以助理名開頭、剝掉禮貌詞後的 rest。 */
export function analyzeAssistantPrefix(text: string, assistantName: string, language: string): AssistantPrefix {
  const assistant = (assistantName ?? "").trim();
  if (!assistant || !text.startsWith(assistant)) {
    return { assistant, rest: "", hasPrefix: false };
  }
  let rest = text.slice(assistant.length).trim();
  const polite = politePattern(language);
  // 最多剝三層禮貌詞（「阿寶請幫忙幫忙…」之類），避免無限循環
  for (let i = 0; i < 3; i++) {
    const next = rest.replace(polite, "");
    if (next === rest) break;
    rest = next;
  }
  return { assistant, rest, hasPrefix: true };
}

export type SkillOutcome =
  | "hit" /** 會觸發 */
  | "layer2-usage" /** 觸發詞＋? → 回用法 */
  | "miss" /** 不比對（觸發詞不符/模式不合） */
  | "blocked-users" /** 白名單擋下 */
  | "skip-disabled" /** 技能停用 */
  | "skip-no-def"; /** 技能定義不存在（外部技能被移除等） */

export interface SkillDecision {
  skill: SkillConfig;
  def?: SkillDefinition;
  outcome: SkillOutcome;
  /** 命中的觸發詞（hit 時才有）。 */
  trigger?: string;
  /** 觸發詞之後的參數（hit/layer2 時有）。 */
  args?: string;
  /** 人類可讀原因（miss/blocked 時為 zh 說明）。 */
  reason?: string;
}

/** 判斷單一技能對這則訊息是否觸發（對齊 runSkills 的迴圈本體）。 */
export function matchSkillEntry(
  skill: SkillConfig,
  def: SkillDefinition | undefined,
  msg: { text: string; chat: string; fromMid: string },
  prefix: AssistantPrefix,
  assistantEnabled: boolean,
): SkillDecision {
  if (!skill.enabled) return { skill, def, outcome: "skip-disabled", reason: "技能已停用" };

  // 技能白名單（B3/G1）：有設定時只允許清單內的使用者/對話呼叫。
  const allowed = skill.allowedUsers ?? [];
  if (allowed.length > 0 && !allowed.includes(msg.fromMid) && !allowed.includes(msg.chat)) {
    return { skill, def, outcome: "blocked-users", reason: `僅限 ${allowed.length} 個指定使用者/對話` };
  }
  if (!def) return { skill, outcome: "skip-no-def", reason: "找不到技能定義（外部技能可能已移除）" };

  const mode = effectiveMode(skill, def);
  if (mode === "any") {
    return { skill, def, outcome: "hit", trigger: "（每則訊息）", args: msg.text };
  }
  if (!assistantEnabled) return { skill, def, outcome: "miss", reason: "助理功能未啟用" };
  if (!prefix.hasPrefix) return { skill, def, outcome: "miss", reason: "訊息沒有以助理名稱開頭" };
  if (!prefix.rest) return { skill, def, outcome: "miss", reason: "只喊了助理名稱，沒有內容" };

  const primary = (skill.trigger || def.defaultTrigger).trim();
  const triggers = [primary, ...(def.triggerAliases ?? [])].filter(Boolean);
  const matched = triggers.find((t) => prefix.rest.startsWith(t));
  if (!matched) return { skill, def, outcome: "miss", reason: "觸發詞不符" };

  const args = prefix.rest.slice(matched.length).trim();
  if (/^[?？]$/.test(args) || /^(help|用法|說明)$/i.test(args)) {
    return { skill, def, outcome: "layer2-usage", trigger: matched, args };
  }
  return { skill, def, outcome: "hit", trigger: matched, args };
}

/** 前綴命中的候選（供最長匹配仲裁；any 模式走另一條路不參與）。 */
export interface TriggerHit {
  skill: SkillConfig;
  def: SkillDefinition;
  trigger: string;
  args: string;
  /** layer2 用法查詢（命中但只顯示用法）。 */
  usage: boolean;
}

export interface TriggerScan {
  /** mode:any 的命中（照舊全部執行，不仲裁）。 */
  anyHits: TriggerHit[];
  /** 前綴命中的候選（含 layer2-usage；待仲裁只取其一）。 */
  prefixHits: TriggerHit[];
  /** 白名單擋下的技能設定（dispatch 記 warn；模擬器顯示 blocked）。 */
  blocked: SkillConfig[];
}

/**
 * 收集一則訊息的所有觸發命中（純函式；真實管線與模擬器共用）。
 * 注意：只收集，不執行；執行順序與裁決由呼叫端決定。
 */
export function scanTriggerHits(
  skills: SkillConfig[],
  msg: { text: string; chat: string; fromMid: string },
  prefix: AssistantPrefix,
  assistantEnabled: boolean,
): TriggerScan {
  const anyHits: TriggerHit[] = [];
  const prefixHits: TriggerHit[] = [];
  const blocked: SkillConfig[] = [];
  for (const skill of skills) {
    const def = getSkill(skill.id);
    const decision = matchSkillEntry(skill, def, msg, prefix, assistantEnabled);
    if (decision.outcome === "skip-disabled" || decision.outcome === "skip-no-def") continue;
    if (decision.outcome === "blocked-users") {
      blocked.push(skill);
      continue;
    }
    if (decision.outcome === "miss") continue;
    if (!def) continue;
    const hit: TriggerHit = {
      skill,
      def,
      trigger: decision.trigger ?? "",
      args: decision.args ?? "",
      usage: decision.outcome === "layer2-usage",
    };
    if (effectiveMode(skill, def) === "any") anyHits.push(hit);
    else prefixHits.push(hit);
  }
  return { anyHits, prefixHits, blocked };
}

/**
 * 最長匹配仲裁：觸發詞最長者勝出；同長度取設定順序第一個。
 * 解掉「倒數計時被倒數攔走」這類跨技能前綴遮蔽；同詞重複（換算×2）只執行其一。
 */
export function selectTriggerHit(prefixHits: TriggerHit[]): TriggerHit | null {
  let best: TriggerHit | null = null;
  for (const hit of prefixHits) {
    if (!best || hit.trigger.length > best.trigger.length) best = hit;
  }
  return best;
}

export interface TriggerConflict {
  word: string;
  kind: "exact" | "prefix";
  owners: string[];
}

/**
 * 觸發詞衝突偵測（純函式；供 /skills 設定頁警示）。
 * 只看已啟用的技能：完全相同 → exact；互為前綴 → prefix；同一技能內部不算。
 */
export function findTriggerConflicts(
  skills: Array<{ id: string; enabled: boolean; words: string[] }>,
): TriggerConflict[] {
  const active = skills.filter((s) => s.enabled);
  const byWord = new Map<string, Set<string>>();
  for (const s of active) {
    for (const raw of s.words) {
      const w = raw.trim();
      if (!w) continue;
      const set = byWord.get(w) ?? new Set<string>();
      set.add(s.id);
      byWord.set(w, set);
    }
  }
  const out: TriggerConflict[] = [];
  const words = [...byWord.keys()];
  // 完全相同：同一詞被多個技能宣告
  for (const w of words) {
    const owners = [...(byWord.get(w) ?? [])].sort();
    if (owners.length >= 2) out.push({ word: w, kind: "exact", owners });
  }
  // 互為前綴：不同詞，一個是另一個的開頭
  const seen = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const a = words[i];
      const b = words[j];
      if (!(a.startsWith(b) || b.startsWith(a))) continue;
      const owners = [...new Set([...(byWord.get(a) ?? []), ...(byWord.get(b) ?? [])])].sort();
      if (owners.length < 2) continue;
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ word: a.length >= b.length ? a : b, kind: "prefix", owners });
    }
  }
  return out.sort((x, y) => x.word.localeCompare(y.word, "zh-Hant"));
}

/** 轉發規則比對（對齊 runForwardRules）；回傳命中與否與推導出的轉發內容。 */
export function matchForwardRule(
  rule: ForwardRule,
  text: string,
  chat: string,
  chatName: string,
  fromName: string,
): { matched: boolean; forwarded: string; reason: string } {
  if (!rule.enabled || !rule.target)
    return { matched: false, forwarded: "", reason: !rule.enabled ? "規則未啟用" : "未設定目標" };
  if (rule.source && rule.source.trim() !== "" && rule.source.trim() !== chat) {
    return { matched: false, forwarded: "", reason: `來源限「${rule.source.trim()}」` };
  }

  let matched: boolean;
  if (rule.match === "all") matched = true;
  else if (rule.match === "regex") {
    try {
      matched = new RegExp(rule.keyword, "i").test(text);
    } catch {
      return { matched: false, forwarded: "", reason: "關鍵字不是合法的正則" };
    }
  } else {
    const keywords = rule.keyword
      .split("|")
      .map((k) => k.trim())
      .filter(Boolean);
    // 與舊行為一致：關鍵字空白視為全部轉發
    matched = keywords.length === 0 || keywords.some((k) => text.includes(k));
  }
  if (!matched) {
    const what =
      rule.match === "all" ? "all" : rule.match === "regex" ? `正則 /${rule.keyword}/` : `關鍵字「${rule.keyword}」`;
    return { matched: false, forwarded: "", reason: `不符（${what}）` };
  }

  const parts: string[] = [];
  if (rule.prefix) parts.push(rule.prefix);
  if (rule.includeSender) parts.push(`[${chatName || fromName || "未知"}]`);
  parts.push(text);
  return { matched: true, forwarded: parts.join(" "), reason: rule.match };
}

/** 解析指令前綴；非指令訊息回 null。 */
export function parseCommandInput(
  text: string,
  prefix = config.commands.prefix || "!",
): { command: string; args: string } | null {
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length).trim();
  const spaceIdx = rest.indexOf(" ");
  const command = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
  return { command, args };
}

/** 指令白名單（空 = 所有人）。 */
export function commandAllowed(fromMid: string, chat: string, allow: string[] = config.commands.allowFrom): boolean {
  const list = allow.map((item) => item.trim()).filter(Boolean);
  return list.length === 0 || list.includes(fromMid) || list.includes(chat);
}

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
  /**
   * 改期（勿擾延後用）。選填：沒有的平台在勿擾時段照常執行並記 warn。
   * 各 adapter 實作皆為一行委派（this.updateScheduled）。
   */
  updateScheduledTask?: (id: string, patch: { runAt?: number; repeat?: string | null }) => ScheduledJobView | null;
  enqueueText(to: string, text: string): Promise<void>;
  getQueueStats(): { pending: number; running: boolean };
  listScheduled(): ScheduledJobView[];
}

/** 收到訊息後的統一管線：去重 → 指令 → 技能 → 轉發規則。 */
export async function dispatchIncoming(msg: IncomingMessage, deps: DispatchDeps): Promise<void> {
  try {
    if (!msg.chat) return;
    if (seenInbound(deps.platform, msg.messageId)) {
      recordMetric("im_inbound_total", 1, { platform: deps.platform, dedup: "true" });
      return;
    }
    recordMetric("im_inbound_total", 1, { platform: deps.platform, dedup: "false" });
    await runCommand(msg.text, msg.chat, msg.fromId, deps);
    await runSkills(msg.text, msg.chat, msg.fromName, msg.fromId, deps, msg.images, msg.location);
    await runForwardRules(msg.text, msg.chat, msg.fromName, msg.chatName, deps);
  } catch (error) {
    logger.error("處理收到的訊息失敗", { error: String(error) });
  }
}

/**
 * 勿擾窗口（分鐘制）。from == to 視為未設定（回 null），避免誤開全天靜音。
 */
export interface QuietWindow {
  fromMin: number;
  toMin: number;
}

export function parseQuietWindow(from: string, to: string): QuietWindow | null {
  const m = (s: string): number | null => {
    const r = /^\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*$/.exec(s ?? "");
    return r ? Number(r[1]) * 60 + Number(r[2]) : null;
  };
  const f = m(from);
  const t = m(to);
  if (f === null || t === null || f === t) return null;
  return { fromMin: f, toMin: t };
}

/** 此刻是否在勿擾窗口內（支援跨夜：from > to）。 */
export function isQuietMinutes(nowMin: number, w: QuietWindow): boolean {
  if (w.fromMin < w.toMin) return nowMin >= w.fromMin && nowMin < w.toMin;
  return nowMin >= w.fromMin || nowMin < w.toMin;
}

/**
 * 算出勿擾結束時刻（ms）：今天的 to，若已過則順延一天。
 * parts 取自 nowInTz() 的本地欄位（即設定時區牆鐘）。
 */
export function quietEndMs(
  nowMs: number,
  parts: { year: number; month: number; day: number },
  w: QuietWindow,
  timeZone: string,
): number {
  const at = (day: number): number =>
    zonedTimeToMs(
      { year: parts.year, month: parts.month, day, hour: Math.floor(w.toMin / 60), minute: w.toMin % 60 },
      timeZone,
    );
  const end = at(parts.day);
  return end <= nowMs ? at(parts.day + 1) : end;
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
  // 推播總管：全域靜音／單一靜音直接略過（保留排程）；勿擾時段延後到結束（不丟失）。
  const meta = loadSchedulesMeta();
  if (meta.globalMute) {
    logger.info("推播被全域靜音略過", { skill: ref.skillId, task: ref.task, chat: ref.chat });
    return;
  }
  if (meta.muted[job.id]) {
    logger.info("推播被單一靜音略過", { skill: ref.skillId, task: ref.task, chat: ref.chat });
    return;
  }
  const qw = meta.quiet.enabled ? parseQuietWindow(meta.quiet.from, meta.quiet.to) : null;
  if (qw) {
    const now = nowInTz();
    if (isQuietMinutes(now.getHours() * 60 + now.getMinutes(), qw)) {
      if (deps.updateScheduledTask) {
        const end = quietEndMs(
          Date.now(),
          { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
          qw,
          config.timezone,
        );
        const moved = deps.updateScheduledTask(job.id, { runAt: end });
        logger.info("勿擾時段，推播延後執行", {
          skill: ref.skillId,
          task: ref.task,
          chat: ref.chat,
          end: new Date(end).toISOString(),
          moved: !!moved,
        });
        if (moved) return;
        // 改期失敗 → 掉下去照常執行（寧可吵到也不丟失）
      } else {
        logger.warn("勿擾時段但此平台不支援改期，照常執行", { skill: ref.skillId, task: ref.task });
      }
    }
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
  const taskStartedAt = Date.now();
  try {
    await def.onTask(taskCtx);
    recordDuration("skill_duration_seconds", (Date.now() - taskStartedAt) / 1000, { skill: ref.skillId });
    recordLastRun(job.id, { at: Date.now(), ok: true });
    recordSkillRun(ref.skillId, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDuration("skill_duration_seconds", (Date.now() - taskStartedAt) / 1000, { skill: ref.skillId });
    recordMetric("skill_errors_total", 1, { skill: ref.skillId, class: classifySkillError(message) });
    logger.error("技能任務執行失敗", {
      skill: ref.skillId,
      task: ref.task,
      error: message,
    });
    recordLastRun(job.id, { at: Date.now(), ok: false, error: message });
    recordSkillRun(ref.skillId, false, message);
  }
}

/** 命中後的執行本體（正常技能比對與 AI 對話模式直送共用，避免兩邊漂移）。 */
async function runMatchedSkill(
  skill: SkillConfig,
  def: SkillDefinition,
  msg: { text: string; args: string; chat: string; fromName: string; fromMid: string; images?: IncomingImage[]; location?: IncomingLocation },
  deps: DispatchDeps,
): Promise<void> {
  const { text, args, chat, fromName, fromMid, images, location } = msg;
  if (skillThrottled(skill.id, chat)) {
    logger.warn("技能觸發過於頻繁，已略過", { skill: skill.id, chat });
    recordMetric("skill_exec_total", 1, { skill: skill.id, result: "throttled" });
    return;
  }
  recordMetric("skill_exec_total", 1, { skill: skill.id, result: "run" });

  logger.info("觸發技能", { skill: skill.id, mode: effectiveMode(skill, def), chat });
  const runStartedAt = Date.now();
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
      ...(images && images.length > 0 ? { images } : {}),
      ...(location ? { location } : {}),
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
        const job = jobs.find((j) => j.id === taskOrId) ?? jobs.find((j) => j.skillTask?.task === taskOrId);
        return job ? deps.readTaskState(job.id) : undefined;
      },
    };
    await def.run(ctx);
    recordDuration("skill_duration_seconds", (Date.now() - runStartedAt) / 1000, { skill: skill.id });
    recordSkillRun(skill.id, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDuration("skill_duration_seconds", (Date.now() - runStartedAt) / 1000, { skill: skill.id });
    recordMetric("skill_errors_total", 1, { skill: skill.id, class: classifySkillError(message) });
    logger.error("技能執行失敗", { skill: skill.id, error: message });
    recordSkillRun(skill.id, false, message);
    writeDeadLetter({
      platform: deps.platform,
      kind: `skill:${skill.id}`,
      to: [chat],
      summary: def.name,
      error: message,
    });
    // 錯誤回覆本身也要保護：回覆失敗不可擊倒後續技能與轉發規則。
    try {
      await deps.replyTo(chat, `技能「${def.name}」執行失敗：${message}`);
    } catch (replyError) {
      logger.error("技能錯誤回覆失敗", {
        skill: skill.id,
        error: replyError instanceof Error ? replyError.message : String(replyError),
      });
    }
  }
}

/**
 * AI 模式到期主動通知 timer（chat → timeout）。
 * 狀態本身仍由 ai/mode.ts 的 Map 保管；這裡只負責「時間到就發一次已退出」。
 * 觸發時一律經 consumeExpiredAiMode 判定，確保與訊息路徑的惰性通知不會重複發送。
 */
const aiModeTimers = new Map<string, NodeJS.Timeout>();

/** 到期通知寄送方式（預設走平台服務；測試可注入假函式）。 */
export type AiModeNotifier = (platform: string, chat: string, text: string) => Promise<void>;

async function defaultAiModeNotifier(platform: string, chat: string, text: string): Promise<void> {
  const svc = getService(platform as Platform);
  if (!svc) {
    logger.warn("AI 模式到期通知無服務可送", { platform, chat });
    return;
  }
  try {
    await svc.sendAdvanced([{ to: chat, text }]);
  } catch (error) {
    logger.warn("AI 模式到期通知發送失敗", {
      platform,
      chat,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 啟動／重設到期 timer（舊的先清；ttl<=0 或空 chat 直接略過）。 */
export function armAiModeExpiryNotice(
  platform: string,
  chat: string,
  ttlMs: number,
  notify: AiModeNotifier = defaultAiModeNotifier,
): void {
  disarmAiModeTimer(chat);
  if (!chat || ttlMs <= 0) return;
  const timer = setTimeout(() => {
    // async IIFE＋內層 try/catch：timer 回呼拋錯會炸 event loop，一律吞掉（各層已記 log）。
    void (async () => {
      try {
        aiModeTimers.delete(chat);
        if (!consumeExpiredAiMode(chat)) return;
        await notify(platform, chat, "已退出AI mode。");
      } catch {
        /* 到期通知失敗不影響主流程 */
      }
    })();
  }, ttlMs);
  timer.unref?.();
  aiModeTimers.set(chat, timer);
}

/** 取消到期 timer（stop／清除／重設前呼叫）。 */
export function disarmAiModeTimer(chat: string): void {
  const t = aiModeTimers.get(chat);
  if (t) {
    clearTimeout(t);
    aiModeTimers.delete(chat);
  }
}

/**
 * AI 對話模式的開關指令處理（前綴觸發時呼叫；白名單不符直接靜默，避免洩漏設定）。
 * 有處理就回傳 true（呼叫端直接 return），沒處理回傳 false。
 */
async function handleAiModeCommand(
  cmd: "start" | "stop",
  skill: SkillConfig,
  msg: { chat: string; fromMid: string },
  deps: DispatchDeps,
): Promise<boolean> {
  const allowed = skill.allowedUsers ?? [];
  if (allowed.length > 0 && !allowed.includes(msg.fromMid) && !allowed.includes(msg.chat)) return false;
  if (cmd === "stop") {
    const was = isAiModeActive(msg.chat);
    clearAiMode(msg.chat);
    disarmAiModeTimer(msg.chat);
    await deps.replyTo(msg.chat, was ? "已離開 AI 對話模式。" : "目前沒有啟動 AI 對話模式。");
    return true;
  }
  if (!aiGroupModeOn(skill.config) && isGroupChat(deps.platform, msg.chat)) return false;
  const ttl = aiModeTtlMs(skill.config);
  const mins = Math.max(1, Math.round(ttl / 60000));
  const was = isAiModeActive(msg.chat);
  touchAiMode(msg.chat, ttl);
  armAiModeExpiryNotice(deps.platform, msg.chat, ttl);
  await deps.replyTo(
    msg.chat,
    was
      ? `AI 對話模式已在進行中，已重新計時 ${mins} 分鐘。`
      : `已進入 AI 對話模式，接下來 ${mins} 分鐘可以直接問我，不用加觸發詞；有新訊息會自動延長，說「關閉AI模式」可隨時結束。`,
  );
  return true;
}

async function runSkills(
  text: string,
  chat: string,
  fromName: string,
  fromMid: string,
  deps: DispatchDeps,
  images?: IncomingImage[],
  location?: IncomingLocation,
): Promise<void> {
  if (!text && (!images || images.length === 0) && !location) return;

  // 位置訊息：所有宣告 handlesLocation 的技能各回一則（YouBike 附近站＋公車附近站牌）。
  // 連 AI 對話模式都不搶——位置只有附近查詢消費得了；無人處理時給一句提示。
  // 文字版位置（部分平台降級成文字＋地圖連結）也在此還原。
  const loc = location ?? extractLocationFromText(text);
  if (loc) {
    const handlers = config.skills.filter((s) => {
      if (!s.enabled || !getSkill(s.id)?.handlesLocation) return false;
      const allowed = s.allowedUsers ?? [];
      return allowed.length === 0 || allowed.includes(fromMid) || allowed.includes(chat);
    });
    if (handlers.length === 0) {
      logger.info("收到位置訊息但無技能處理", { chat });
      await deps.replyTo(chat, "收到你的位置了，但目前沒有可查詢附近的技能。");
      return;
    }
    for (const entry of handlers) {
      const def = getSkill(entry.id);
      if (def) {
        await runMatchedSkill(entry, def, { text, args: text, chat, fromName, fromMid, images, location: loc }, deps);
      }
    }
    return;
  }

  const { assistant, rest, hasPrefix } = analyzeAssistantPrefix(text, config.assistant.name, config.language);

  // Layer 1：只喊助理名稱、未帶觸發詞 → 列出可用技能
  if (config.assistant.enabled && hasPrefix && rest === "") {
    logger.info("列出可用技能", { chat });
    await deps.replyTo(chat, skillListText(config.language));
    return;
  }

  // AI 對話模式（ai/mode.ts）：前綴指令開關＋無前綴直問路由＋到期一次性通知。
  {
    const aiEntry = config.skills.find((s) => s.id === "ai");
    const aiUsable = !!aiEntry?.enabled && aiModeTtlMs(aiEntry?.config) > 0;
    if (!aiUsable) {
      if (isAiModeActive(chat)) {
        clearAiMode(chat); // 功能關閉或技能停用：靜默清除殘留
        disarmAiModeTimer(chat);
      }
    } else {
      const cmd = hasPrefix ? detectAiModeCommand(rest) : detectAiModeCommand(text);
      if (cmd) {
        if (await handleAiModeCommand(cmd, aiEntry!, { chat, fromMid }, deps)) return;
      } else if (isAiModeActive(chat)) {
        const ttl = aiModeTtlMs(aiEntry!.config);
        touchAiMode(chat, ttl);
        armAiModeExpiryNotice(deps.platform, chat, ttl); // 有新訊息自動延長：timer 跟著重設
        if (!aiGroupModeOn(aiEntry!.config) && isGroupChat(deps.platform, chat)) {
          clearAiMode(chat); // 群組未開放：靜默清除，不打擾
          disarmAiModeTimer(chat);
        } else {
          const def = getSkill(aiEntry!.id);
          if (!def) {
            clearAiMode(chat);
            disarmAiModeTimer(chat);
          } else {
            const allowed = aiEntry!.allowedUsers ?? [];
            if (allowed.length === 0 || allowed.includes(fromMid) || allowed.includes(chat)) {
              await runMatchedSkill(
                aiEntry!,
                def,
                { text, args: text, chat, fromName, fromMid, images },
                deps,
              );
            }
            return;
          }
        }
      } else if (consumeExpiredAiMode(chat)) {
        disarmAiModeTimer(chat); // 防禦：timer 漏清時此處補清，避免殘留
        await deps.replyTo(chat, "已退出AI mode。");
      }
    }
  }

  // 無前綴意圖的比對本文：有助理前綴時用前綴後的 rest，
  // 避免助理名污染技能參數（「阿寶請幫忙 YouBike ?」的 args 該是 ? 而不是全文）。
  const intentText = hasPrefix && rest ? rest : text;

  // 無前綴意圖：匯率／幣價自然換算（「100美金等於台幣」「0.5比特幣值多少」）。
  // AI 對話模式內不搶（模式訊息優先走 AI）；停用或白名單不符時靜默略過。
  {
    const fx = parseConversion(intentText);
    const cx = fx ? null : parseCryptoConversion(intentText);
    const conv = fx
      ? { skillId: "exchange-rate", args: conversionArgs(fx) }
      : cx
        ? { skillId: "crypto", args: `${cx.coin.key} ${cx.amount ?? ""}`.trim() }
        : null;
    if (conv) {
      const entry = config.skills.find((s) => s.id === conv.skillId);
      const def = getSkill(conv.skillId);
      const allowed = entry?.allowedUsers ?? [];
      if (
        entry?.enabled &&
        def &&
        (allowed.length === 0 || allowed.includes(fromMid) || allowed.includes(chat))
      ) {
        await runMatchedSkill(entry, def, { text, args: conv.args, chat, fromName, fromMid, images }, deps);
        return;
      }
    }
  }

  // 無前綴意圖：航班班號（「CI100到了沒」→ flight-status）。
  // 有前綴且原文帶航班/班機時放寬為純班號（「阿寶請幫忙 航班 JX715 11/18」）。
  {
    const fn =
      parseFlightIntent(intentText) ??
      (hasPrefix && /航班|班機/.test(text) ? parseFlightNo(intentText) : null);
    if (fn) {
      const entry = config.skills.find((s) => s.id === "flight-status");
      const def = getSkill("flight-status");
      const allowed = entry?.allowedUsers ?? [];
      if (
        entry?.enabled &&
        def &&
        (allowed.length === 0 || allowed.includes(fromMid) || allowed.includes(chat))
      ) {
        await runMatchedSkill(entry, def, { text, args: intentText, chat, fromName, fromMid, images }, deps);
        return;
      }
    }
  }

  // 無前綴自然意圖（「台北天氣如何」→ 天氣；AI 對話模式內不搶，停用/白名單不符靜默略過）。
  {
    const entry = findNaturalIntent(intentText, chat, fromMid, deps.platform);
    if (entry) {
      const def = getSkill(entry.id);
      if (def) {
        await runMatchedSkill(entry, def, { text, args: intentText, chat, fromName, fromMid, images }, deps);
        return;
      }
    }
  }

  // 前綴觸發：先收集全部命中再仲裁（any 模式照舊全執行；前綴命中只取其一）。
  // 最長觸發詞勝出（「倒數計時」贏「倒數」）；同長度取設定順序第一個並記 warn。
  let handled = false;
  const scan = scanTriggerHits(
    config.skills,
    { text, chat, fromMid },
    { assistant, rest, hasPrefix },
    config.assistant.enabled,
  );
  for (const blocked of scan.blocked) {
    logger.warn("技能呼叫被白名單擋下", { skill: blocked.id, fromMid, chat });
  }
  for (const hit of scan.anyHits) {
    await runMatchedSkill(hit.skill, hit.def, { text, args: hit.args, chat, fromName, fromMid, images }, deps);
    handled = true;
  }
  const winner = selectTriggerHit(scan.prefixHits);
  if (winner) {
    if (winner.usage) {
      // Layer 2：<觸發詞> ? → 顯示該技能用法
      const primaryTrigger = (winner.skill.trigger || winner.def.defaultTrigger).trim();
      logger.info("顯示技能用法", { skill: winner.skill.id, chat });
      await deps.replyTo(chat, skillUsageText(winner.def, primaryTrigger, config.language));
    } else {
      await runMatchedSkill(
        winner.skill,
        winner.def,
        { text, args: winner.args, chat, fromName, fromMid, images },
        deps,
      );
    }
    handled = true;
    if (scan.prefixHits.length > 1) {
      const losers = scan.prefixHits.filter((h) => h !== winner).map((h) => h.skill.id);
      logger.warn("觸發詞重複，僅執行最長匹配", { winner: winner.skill.id, trigger: winner.trigger, losers });
    }
  }

  // LLM 意圖分類後備（前面都沒命中才問；沒配 LLM 時自動關閉；失敗/無關靜默略過）。
  if (!handled && text.trim() && routerAvailable()) {
    try {
      const decision = await classifyIntent(text, collectRouterCandidates());
      if (decision?.skillId) {
        const entry = config.skills.find((s) => s.id === decision.skillId);
        const def = entry ? getSkill(entry.id) : undefined;
        const allowed = entry?.allowedUsers ?? [];
        if (
          entry?.enabled &&
          def &&
          (allowed.length === 0 || allowed.includes(fromMid) || allowed.includes(chat))
        ) {
          await runMatchedSkill(entry, def, { text, args: decision.args || text, chat, fromName, fromMid, images }, deps);
        }
      }
    } catch (error) {
      logger.warn("意圖分類後備失敗", { chat, error: error instanceof Error ? error.message : String(error) });
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
    const { matched, forwarded } = matchForwardRule(rule, text, chat, chatName, fromName);
    if (!matched) continue;

    try {
      await deps.enqueueText(rule.target, forwarded);
      logger.info("訊息已轉發（規則）", { from: chat, to: rule.target });
    } catch (error) {
      logger.error("轉發規則失敗", { to: rule.target, error: String(error) });
    }
  }
}

async function runCommand(text: string, chat: string, fromMid: string, deps: DispatchDeps): Promise<void> {
  if (!config.commands.enabled) return;
  const parsed = parseCommandInput(text);
  if (!parsed) return;
  const { command, args } = parsed;

  if (!commandAllowed(fromMid, chat)) {
    logger.info("指令來源未授權，略過", { fromMid });
    return;
  }

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
