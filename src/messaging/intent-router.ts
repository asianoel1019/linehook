import { config } from "../config.js";
import { logger } from "../logger.js";
import { chat, llmConfigFrom, type ChatMessage } from "../skills/llm.js";
import { getSkill } from "../skills/index.js";
import { effectiveMode } from "../skills/help.js";

export interface IntentCandidate {
  id: string;
  blurb: string;
}

export interface IntentDecision {
  skillId: string | null;
  args: string;
}

/** 免 key 可用的 provider（其餘都要 apiKey；對齊 llm.ts 的 requireKey 邏輯）。 */
const KEYLESS_PROVIDERS = new Set(["local", "gemini-cli", "opencode-cli"]);

/** 沒配好 LLM（無模型／需 key 但沒 key）時回 false，router 自動關閉。 */
export function routerAvailable(): boolean {
  try {
    const cfg = llmConfigFrom({});
    if (!cfg.model) return false;
    if (KEYLESS_PROVIDERS.has(cfg.provider)) return true;
    return cfg.apiKey.length > 0;
  } catch {
    return false;
  }
}

/** 可被分類命中的技能（啟用中、有觸發詞、非 any 模式）。 */
export function collectRouterCandidates(): IntentCandidate[] {
  const out: IntentCandidate[] = [];
  for (const entry of config.skills) {
    if (!entry.enabled) continue;
    const def = getSkill(entry.id);
    if (!def) continue;
    if (effectiveMode(entry, def) === "any") continue;
    const trigger = (entry.trigger || def.defaultTrigger).trim();
    if (!trigger) continue;
    const desc = typeof def.description === "string" ? def.description : (def.description.zh || "");
    out.push({ id: entry.id, blurb: `${def.name}：${desc.slice(0, 36)}` });
  }
  return out;
}

export function buildRouterMessages(text: string, candidates: IntentCandidate[]): ChatMessage[] {
  const list = candidates.map((c) => `- ${c.id}：${c.blurb}`).join("\n");
  return [
    {
      role: "system",
      content:
        "你是聊天機器人的意圖分類器。只能回 JSON，不要多話。\n" +
        `技能清單（id：說明）：\n${list}\n` +
        "判斷使用者訊息最相關的技能；閒聊、打招呼、表情符號等無關訊息回 {\"skill\":null}。\n" +
        "有關則回 {\"skill\":\"<id>\",\"args\":\"<傳給技能的參數原文>\"}；" +
        "args 保留地名、數字、關鍵細節，拿掉稱呼和語助詞。只回 JSON。",
    },
    { role: "user", content: text },
  ];
}

/** 解析模型回覆；格式壞、id 不在候選一律回 null（寧可不答不亂答）。 */
export function parseRouterReply(raw: string, validIds: Set<string>): IntentDecision | null {
  const m = /\{[^{}]*\}/.exec(raw ?? "");
  if (!m) return null;
  let obj: { skill?: unknown; args?: unknown };
  try {
    obj = JSON.parse(m[0]) as { skill?: unknown; args?: unknown };
  } catch {
    return null;
  }
  if (obj.skill === null || obj.skill === undefined) return { skillId: null, args: "" };
  if (typeof obj.skill !== "string" || !validIds.has(obj.skill)) return null;
  return { skillId: obj.skill, args: typeof obj.args === "string" ? obj.args : "" };
}

const CACHE_MAX = 300;
const CACHE_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; decision: IntentDecision | null }>();

function cacheGet(key: string): { found: boolean; decision: IntentDecision | null } {
  const hit = cache.get(key);
  if (!hit) return { found: false, decision: null };
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return { found: false, decision: null };
  }
  return { found: true, decision: hit.decision };
}

function cacheSet(key: string, decision: IntentDecision | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), decision });
}

/** 測試用：清空分類快取。 */
export function clearIntentCache(): void {
  cache.clear();
}

async function defaultRouterChat(messages: ChatMessage[]): Promise<string> {
  const cfg = llmConfigFrom({});
  return chat({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 20_000) }, messages, { skill: "intent-router" });
}

/**
 * LLM 意圖分類（後備用）。chatFn 可注入假函式測試；失敗一律回 null。
 * 同一原文 10 分鐘內只問一次（快取）。
 */
export async function classifyIntent(
  text: string,
  candidates: IntentCandidate[],
  chatFn: (messages: ChatMessage[]) => Promise<string> = defaultRouterChat,
): Promise<IntentDecision | null> {
  const key = text.trim();
  if (!key || candidates.length === 0) return null;
  const hit = cacheGet(key);
  if (hit.found) return hit.decision;
  let decision: IntentDecision | null = null;
  try {
    const raw = await chatFn(buildRouterMessages(key, candidates));
    decision = parseRouterReply(raw, new Set(candidates.map((c) => c.id)));
  } catch (error) {
    logger.warn("意圖分類失敗", { error: error instanceof Error ? error.message : String(error) });
    decision = null;
  }
  cacheSet(key, decision);
  return decision;
}
