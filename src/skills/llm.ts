import { logger } from "../logger.js";
import { recordMetric } from "../metrics.js";

export type LlmProvider = "openai" | "gemini" | "opencode" | "local" | "custom";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function providerDefaults(provider: LlmProvider): { baseUrl: string; model: string } {
  switch (provider) {
    case "gemini":
      return { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash" };
    case "opencode":
      return { baseUrl: "https://opencode.ai/zen/v1", model: "opencode/deepseek-v4.1-flash" };
    case "local":
      return { baseUrl: "http://localhost:11434/v1", model: "llama3.1" };
    case "custom":
      return { baseUrl: "", model: "" };
    case "openai":
    default:
      return { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  }
}

export function llmConfigFrom(raw: Record<string, string>): LlmConfig {
  const provider = ((raw.provider || "openai").trim() as LlmProvider) || "openai";
  const defaults = providerDefaults(provider);
  return {
    provider,
    baseUrl: (raw.baseUrl || defaults.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: (raw.apiKey || "").trim(),
    model: (raw.model || defaults.model).trim(),
    systemPrompt: (raw.systemPrompt || "").trim(),
    temperature: numOr(raw.temperature, 0.7),
    maxTokens: Math.max(1, Math.floor(numOr(raw.maxTokens, 2048))),
    timeoutMs: Math.max(1000, Math.floor(numOr(raw.timeoutMs, 30_000))),
  };
}

function numOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 呼叫 LLM，回傳純文字；失敗丟錯。tag.skill 供用量統計歸屬。 */
export async function chat(cfg: LlmConfig, messages: ChatMessage[], tag?: { skill?: string }): Promise<string> {
  if (!cfg.model) throw new Error("未設定模型（model）");
  if (cfg.provider === "gemini") return geminiChat(cfg, messages, tag);
  return openaiCompatChat(cfg, messages, cfg.provider !== "local", tag);
}

/** OpenAI-compatible：OpenAI、OpenCode、本地自建、custom 皆適用。 */
async function openaiCompatChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  requireKey: boolean,
  tag?: { skill?: string },
): Promise<string> {
  if (requireKey && !cfg.apiKey) throw new Error("未設定 API key");
  const base = cfg.baseUrl || "http://localhost:11434/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}${body ? `：${body.slice(0, 150)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  let text = choice?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("LLM 未回傳內容");
  text = text.trim();
  if (choice?.finish_reason === "length") {
    text += "\n\n（回覆因長度上限中斷，可到技能設定調高「最大回覆 tokens」）";
  }
  recordLlmUsage(cfg, tag?.skill, data.usage?.prompt_tokens, data.usage?.completion_tokens);
  return text;
}

/** Google Gemini generateContent。 */
async function geminiChat(cfg: LlmConfig, messages: ChatMessage[], tag?: { skill?: string }): Promise<string> {
  if (!cfg.apiKey) throw new Error("未設定 Gemini API key");
  const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const res = await fetch(`${base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}${body ? `：${body.slice(0, 150)}` : ""}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const cand = data.candidates?.[0];
  let text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini 未回傳內容");
  text = text.trim();
  if (cand?.finishReason === "MAX_TOKENS") {
    text += "\n\n（回覆因長度上限中斷，可到技能設定調高「最大回覆 tokens」）";
  }
  recordLlmUsage(cfg, tag?.skill, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
  return text;
}

/** G2：記錄 LLM token 用量（供 /metrics 的 llm_tokens_total）。缺 usage 時記 0 佔位。 */
function recordLlmUsage(cfg: LlmConfig, skill: string | undefined, prompt?: number, completion?: number): void {
  const labels = { provider: cfg.provider, model: cfg.model, skill: skill ?? "unknown" };
  recordMetric("llm_tokens_total", Math.max(0, prompt ?? 0), { ...labels, kind: "prompt" });
  recordMetric("llm_tokens_total", Math.max(0, completion ?? 0), { ...labels, kind: "completion" });
  recordMetric("llm_calls_total", 1, { provider: cfg.provider, model: cfg.model, skill: skill ?? "unknown" });
}

/** 列出供應商支援的模型 id。 */
export async function listModels(cfg: LlmConfig): Promise<string[]> {
  if (cfg.provider === "gemini") return geminiListModels(cfg);
  return openaiCompatListModels(cfg);
}

async function openaiCompatListModels(cfg: LlmConfig): Promise<string[]> {
  const base = cfg.baseUrl || "http://localhost:11434/v1";
  const res = await fetch(`${base}/models`, {
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`列出模型失敗（HTTP ${res.status}）`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean).sort();
}

async function geminiListModels(cfg: LlmConfig): Promise<string[]> {
  if (!cfg.apiKey) throw new Error("未設定 Gemini API key");
  const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const res = await fetch(`${base}/models?key=${encodeURIComponent(cfg.apiKey)}`, {
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`列出模型失敗（HTTP ${res.status}）`);
  const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  return (data.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort();
}

// ===== 對話記憶（記憶體，每個 chat 保留最近 N 輪）=====
// G3：總 chat 數上限 500（LRU 淘汰），避免緩慢洩漏。
const MAX_CHATS = 500;
const memory = new Map<string, ChatMessage[]>();

export function getHistory(chat: string): ChatMessage[] {
  return [...(memory.get(chat) ?? [])];
}

export function pushHistory(chat: string, turns: ChatMessage[], keepTurns: number): void {
  const max = Math.max(0, keepTurns) * 2;
  const list = (memory.get(chat) ?? []).concat(turns);
  if (max === 0) {
    memory.delete(chat);
    return;
  }
  while (list.length > max) list.shift();
  memory.delete(chat);
  memory.set(chat, list);
  while (memory.size > MAX_CHATS) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

export function clearHistory(chat: string): void {
  memory.delete(chat);
}

/** 清除全部對話記憶（管理用途）。 */
export function clearAllHistory(): number {
  const n = memory.size;
  memory.clear();
  return n;
}

export function logLlmError(skill: string, error: unknown): void {
  logger.error("LLM 呼叫失敗", {
    skill,
    error: error instanceof Error ? error.message : String(error),
  });
}
