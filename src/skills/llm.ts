import { logger } from "../logger.js";
import { recordMetric } from "../metrics.js";
import { config } from "../config.js";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";

export type LlmProvider = "openai" | "gemini" | "gemini-cli" | "opencode" | "local" | "custom";

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
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  /** OpenAI 相容工具呼叫（role=assistant 時帶呼叫清單）。 */
  tool_calls?: ToolCall[];
  /** OpenAI 相容工具結果（role=tool 時指向被呼叫的 id）。 */
  tool_call_id?: string;
  /** Gemini 協定：model 端的 functionCall。 */
  functionCall?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Gemini 協定：user 端的 functionResponse。 */
  functionResponse?: Array<{ name: string; result: string }>;
}

/** 訊息內容片段：文字或圖片（image_url 支援 data:base64 與一般 URL）。 */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 提供給模型的工具宣告（JSON Schema parameters）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** chatWithTools 的結果：要嘛純文字、要嘛一批工具呼叫。 */
export interface ChatWithToolsResult {
  text?: string;
  toolCalls?: ToolCall[];
}

/** 把圖片轉成 OpenAI 相容的 content parts（無圖時回傳純字串）。 */
export function toVisionContent(
  text: string,
  images?: Array<{ base64: string; mimeType: string }>,
): string | ChatContentPart[] {
  if (!images || images.length === 0) return text;
  const parts: ChatContentPart[] = [];
  const prompt = text.trim() || "請看這張圖片並描述內容。";
  parts.push({ type: "text", text: prompt });
  for (const img of images.slice(0, 4)) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
  }
  return parts;
}

function providerDefaults(provider: LlmProvider): { baseUrl: string; model: string } {
  switch (provider) {
    case "gemini":
    case "gemini-cli":
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

export function llmConfigFrom(raw: Record<string, string>, globalLlm?: Record<string, string | number>): LlmConfig {
  const g = globalLlm ?? config.globalLlm;
  const provider = ((raw.provider || String(g.provider || "openai")).trim() as LlmProvider) || "openai";
  const defaults = providerDefaults(provider);
  return {
    provider,
    baseUrl: (raw.baseUrl || String(g.baseUrl || "") || defaults.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: (raw.apiKey || String(g.apiKey || "")).trim(),
    model: (raw.model || String(g.model || "") || defaults.model).trim(),
    systemPrompt: (raw.systemPrompt || String(g.systemPrompt || "")).trim(),
    temperature: numOr(raw.temperature, numOr(String(g.temperature ?? ""), 0.7)),
    maxTokens: Math.max(1, Math.floor(numOr(raw.maxTokens, numOr(String(g.maxTokens ?? ""), 2048)))),
    timeoutMs: Math.max(1000, Math.floor(numOr(raw.timeoutMs, numOr(String(g.timeoutMs ?? ""), 30_000)))),
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
  if (cfg.provider === "gemini-cli") return geminiCliChat(cfg, messages, tag);
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

/** 取純文字（content 可能是 parts）。 */
export function textOf(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** 轉成 Gemini parts：functionCall/functionResponse 訊照協定轉，其餘走文字/圖片。 */
function toGeminiParts(m: ChatMessage): Array<Record<string, unknown>> {
  if (m.functionCall && m.functionCall.length > 0) {
    return m.functionCall.map((f) => ({ functionCall: { name: f.name, args: f.args } }));
  }
  if (m.functionResponse && m.functionResponse.length > 0) {
    return m.functionResponse.map((f) => ({ functionResponse: { name: f.name, response: { result: f.result } } }));
  }
  if (typeof m.content === "string") return [{ text: m.content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of m.content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
      continue;
    }
    const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(part.image_url.url);
    if (dataUrl) {
      parts.push({ inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } });
    } else {
      parts.push({ fileData: { fileUri: part.image_url.url } });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

/** Google Gemini generateContent。 */
async function geminiChat(cfg: LlmConfig, messages: ChatMessage[], tag?: { skill?: string }): Promise<string> {
  if (!cfg.apiKey) throw new Error("未設定 Gemini API key");
  const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m) }));

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

/** Antigravity CLI（原 Gemini CLI）帳戶模式：spawn `agy` 取得回覆（免 API key）。 */
function findAgyPath(): string {
  try {
    const result = execSync("where agy 2>nul || which agy 2>/dev/null", { timeout: 5000, encoding: "utf8" });
    const path = result.split("\n")[0]?.trim();
    if (path) return path;
  } catch {
    /* fallthrough */
  }
  return "agy";
}

/** agy print 模式的 token 用量（各版本欄位名不一，解析時盡量相容）。 */
export interface AgyUsage {
  inputTokens?: number;
  outputTokens?: number;
}

function numField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** 從 agy JSON envelope 抽用量（input/output 欄位名跨版本不一）。 */
function agyUsageOf(usage: unknown): AgyUsage {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: numField(u, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "prompt_token_count",
      "promptTokenCount",
    ]),
    outputTokens: numField(u, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
      "candidates_token_count",
      "candidatesTokenCount",
    ]),
  };
}

/** 疑似帳戶/授權問題時，提示到主機上完成 agy 登入（無 TTY 環境下未登入會直接失敗）。 */
function agyAuthHint(detail: string): string {
  if (!/auth|login|unauthori[sz]ed|unauthenticated|permission denied|forbidden|sign[- ]?in|keyring/i.test(detail))
    return "";
  return "請在主機上執行 agy 完成 Google 帳戶登入後再試；若正式機無桌面 keyring 可用，改用 GEMINI_API_KEY（agy 的 settings.json 設 modelProvider: gemini）";
}

/**
 * 解析 agy `-p --output-format json` 的輸出。
 * 成功回 { text, usage }；失敗回 { error }（錯誤訊息已盡量帶上可操作的說明）。
 */
export function parseAgyResult(
  rawOut: string,
  rawErr: string,
  code: number | null,
): { text: string; usage?: AgyUsage } | { error: string } {
  const out = (rawOut || "").trim();
  const err = (rawErr || "").trim();
  try {
    const data = JSON.parse(out) as {
      status?: string;
      response?: unknown;
      result?: unknown;
      text?: unknown;
      error?: unknown;
      denied_actions?: Array<{ action?: string }>;
      usage?: unknown;
    };
    const textOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const detailOf = (v: unknown): string => {
      if (typeof v === "string") return v.trim();
      if (v && typeof v === "object") {
        const m = v as Record<string, unknown>;
        const msg = textOf(m.message) || textOf(m.error);
        return msg || JSON.stringify(v).slice(0, 200);
      }
      return "";
    };
    const errDetail = detailOf(data.error);
    if (data.status === "ERROR" || errDetail) {
      const hint = agyAuthHint(`${errDetail} ${data.status ?? ""} ${err}`);
      return { error: `Antigravity CLI 錯誤：${errDetail || data.status || "未知錯誤"}${hint ? `（${hint}）` : ""}` };
    }
    const text = textOf(data.response) || textOf(data.result) || textOf(data.text);
    if (text) return { text, usage: agyUsageOf(data.usage) };
    if (data.status === "INTERRUPTED") {
      return { error: "Antigravity CLI 被中斷（逾時或外部干擾），請稍後再試" };
    }
    if ((data.denied_actions ?? []).length > 0) {
      const denied = (data.denied_actions ?? []).map((d) => d.action).join(", ");
      return {
        error: `Antigravity CLI 未回傳內容（工具被拒絕：${denied}）。已使用 --dangerously-skip-permissions，若仍被拒請檢查 agy 版本是否過舊，或在 agy 的 settings.json 以 permissions.allow 加入 allow-rule`,
      };
    }
    if (data.status && data.status !== "SUCCESS") {
      return { error: `Antigravity CLI 回傳未預期的狀態：${data.status}${err ? `（${err.slice(0, 200)}）` : ""}` };
    }
    const emptyDetail = err || out.slice(0, 200) || `exit ${code}`;
    return { error: `Antigravity CLI 未回傳內容：${emptyDetail.slice(0, 300)}` };
  } catch {
    // 非 JSON
  }
  const detail = [err, out].filter(Boolean).join(" | ") || `exit ${code}`;
  const hint = agyAuthHint(detail);
  return { error: `Antigravity CLI 失敗：${detail.slice(0, 300)}${hint ? `（${hint}）` : ""}` };
}

async function geminiCliChat(cfg: LlmConfig, messages: ChatMessage[], tag?: { skill?: string }): Promise<string> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  const last = messages.filter((m) => m.role !== "system").pop();
  const raw = textOf(last?.content ?? "");
  const clean = raw.replace(/<\/?untrusted-(?:user|web)-content>/g, "").trim();
  const prompt = system ? `${system}\n\n${clean}` : clean;
  const agyBin = findAgyPath();
  const timeoutMs = Math.max(cfg.timeoutMs, 300_000); // at least 5 minutes to match --print-timeout

  return new Promise((resolve, reject) => {
    let done = false;
    const proc = spawn(
      agyBin,
      ["-p", prompt, "--output-format", "json", "--print-timeout", "5m", "--dangerously-skip-permissions"],
      {
        timeout: timeoutMs,
        env: { ...process.env, HOME: process.env.HOME || homedir() },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let out = "";
    let err = "";
    proc.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.stderr?.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });

    proc.on("error", (e) => {
      if (done) return;
      done = true;
      const hint = /ENOENT/i.test(e.message)
        ? "請先在主機安裝 Antigravity CLI（npm install -g @google/antigravity-cli）"
        : "";
      logger.error("Antigravity CLI spawn 失敗", { error: e.message });
      reject(new Error(`Antigravity CLI 無法啟動：${e.message}${hint ? `（${hint}）` : ""}`));
    });

    proc.on("close", (code, signal) => {
      if (done) return;
      done = true;
      if (signal) {
        reject(
          new Error(
            `Antigravity CLI 逾時或被終止（${signal}，上限約 ${Math.round(timeoutMs / 1000)} 秒）；若經常卡住，多為等待授權或首次互動設定，請到主機上跑一次 agy 完成設定`,
          ),
        );
        return;
      }
      const r = parseAgyResult(out, err, code);
      if ("text" in r) {
        recordLlmUsage(cfg, tag?.skill, r.usage?.inputTokens, r.usage?.outputTokens);
        resolve(r.text);
      } else {
        logger.error("Antigravity CLI 呼叫失敗", {
          bin: agyBin,
          code,
          stdout: out.trim().slice(0, 300),
          stderr: err.trim().slice(0, 300),
        });
        reject(new Error(r.error));
      }
    });
  });
}

/** G2：記錄 LLM token 用量（供 /metrics 的 llm_tokens_total）。缺 usage 時記 0 佔位。 */
function recordLlmUsage(cfg: LlmConfig, skill: string | undefined, prompt?: number, completion?: number): void {
  const labels = { provider: cfg.provider, model: cfg.model, skill: skill ?? "unknown" };
  recordMetric("llm_tokens_total", Math.max(0, prompt ?? 0), { ...labels, kind: "prompt" });
  recordMetric("llm_tokens_total", Math.max(0, completion ?? 0), { ...labels, kind: "completion" });
  recordMetric("llm_calls_total", 1, { provider: cfg.provider, model: cfg.model, skill: skill ?? "unknown" });
}

/**
 * 工具呼叫一輪：OpenAI 相容（openai/local/custom/opencode）與 Gemini 原生兩種協定。
 * gemini-cli（agy）不支援結構化工具呼叫，丟錯讓呼叫端退回純文字。
 */
export async function chatWithTools(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  tag?: { skill?: string },
): Promise<ChatWithToolsResult> {
  if (tools.length === 0) {
    const text = await chat(cfg, messages, tag);
    return { text };
  }
  if (cfg.provider === "gemini") return geminiChatWithTools(cfg, messages, tools, tag);
  if (cfg.provider === "gemini-cli") throw new Error("Antigravity CLI 模式不支援工具呼叫，請改用 API key 或關閉工具");
  return openaiCompatChatWithTools(cfg, messages, tools, tag);
}

async function openaiCompatChatWithTools(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  tag?: { skill?: string },
): Promise<ChatWithToolsResult> {
  if (!cfg.apiKey && cfg.provider !== "local" && cfg.provider !== "custom") throw new Error("未設定 API key");
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
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}${body ? `：${body.slice(0, 150)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = data.choices?.[0]?.message;
  recordLlmUsage(cfg, tag?.skill, data.usage?.prompt_tokens, data.usage?.completion_tokens);
  const calls = message?.tool_calls ?? [];
  if (calls.length > 0) {
    return {
      toolCalls: calls.map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        args: safeArgs(c.function?.arguments),
      })),
    };
  }
  const text = (message?.content ?? "").trim();
  if (!text) throw new Error("LLM 未回傳內容");
  return { text };
}

async function geminiChatWithTools(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  tag?: { skill?: string },
): Promise<ChatWithToolsResult> {
  if (!cfg.apiKey) throw new Error("未設定 Gemini API key");
  const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m) }));

  const res = await fetch(`${base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: "POST",
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}${body ? `：${body.slice(0, 150)}` : ""}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  recordLlmUsage(cfg, tag?.skill, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const fns = parts.filter((p) => p.functionCall);
  if (fns.length > 0) {
    return {
      toolCalls: fns.map((p, i) => ({
        id: `gemini_${i}`,
        name: p.functionCall?.name ?? "",
        args: (p.functionCall?.args ?? {}) as Record<string, unknown>,
      })),
    };
  }
  const text = parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini 未回傳內容");
  return { text };
}

/** 解析工具參數 JSON；壞JSON 回空物件（工具端會驗證）。 */
function safeArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 列出供應商支援的模型 id。 */
export async function listModels(cfg: LlmConfig): Promise<string[]> {
  if (cfg.provider === "gemini-cli") return antigravityListModels();
  if (cfg.provider === "gemini") return geminiListModels(cfg);
  return openaiCompatListModels(cfg);
}

async function antigravityListModels(): Promise<string[]> {
  const agyBin = findAgyPath();
  return new Promise((resolve) => {
    const proc = spawn(agyBin, ["models"], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.on("close", () => {
      const models = out
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((s) => /^[a-z0-9.\-]+$/i.test(s));
      resolve(models.length > 0 ? models : ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"]);
    });
    proc.on("error", () => {
      resolve(["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"]);
    });
  });
}

async function openaiCompatListModels(cfg: LlmConfig): Promise<string[]> {
  const base = cfg.baseUrl || "http://localhost:11434/v1";
  const res = await fetch(`${base}/models`, {
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`列出模型失敗（HTTP ${res.status}）`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((m) => m.id ?? "")
    .filter(Boolean)
    .sort();
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
