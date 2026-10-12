/** Agent 迴圈：模型 ↔ 工具 多輪對話，直到模型給出純文字（或達到輪數上限）。 */

import { chat, chatWithTools, textOf, type ChatMessage, type LlmConfig, type ToolCall } from "./llm.js";
import { TOOL_SPECS, executeTool, type ToolContext } from "./tools.js";

export interface AgentRunOptions {
  system: string;
  /** 使用者提問（純文字或含圖 content parts）。 */
  prompt: string | ChatMessage["content"];
  /** 對話記憶（本輪之前的多輪）。 */
  history?: ChatMessage[];
  /** 是否啟用工具；false 直接單輪 chat。 */
  tools?: boolean;
  toolContext?: ToolContext;
  /** 最多幾輪工具往返（預設 3，上限 5）。 */
  maxRounds?: number;
  tag?: { skill?: string };
}

export interface AgentRunResult {
  text: string;
  toolRounds: number;
}

/** 跑一輪 agent：視需要呼叫工具並把結果餵回模型，最後回純文字。 */
export async function runAgent(cfg: LlmConfig, opts: AgentRunOptions): Promise<AgentRunResult> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  for (const h of opts.history ?? []) messages.push(h);
  messages.push({ role: "user", content: opts.prompt });

  if (!opts.tools) {
    const text = await chat(cfg, messages, opts.tag);
    return { text, toolRounds: 0 };
  }

  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 3, 5));
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    const result = await chatWithTools(cfg, messages, TOOL_SPECS, opts.tag);
    if (result.text) return { text: result.text, toolRounds: rounds };

    const calls = (result.toolCalls ?? []).filter((c) => c.name);
    if (calls.length === 0) throw new Error("模型未回傳內容");
    rounds += 1;

    const outputs = await Promise.all(calls.map((c) => executeTool(c.name, c.args, opts.toolContext ?? {})));

    if (cfg.provider === "gemini") {
      // Gemini 協定：model(functionCall) → user(functionResponse)
      messages.push({
        role: "assistant",
        content: "",
        functionCall: calls.map((c) => ({ name: c.name, args: c.args })),
      });
      messages.push({
        role: "user",
        content: "",
        functionResponse: calls.map((c, i) => ({ name: c.name, result: outputs[i] })),
      });
    } else {
      // OpenAI 相容協定：assistant(tool_calls) → tool(tool_call_id)
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const [i, call] of calls.entries()) {
        messages.push({ role: "tool", tool_call_id: call.id, content: outputs[i] });
      }
    }
  }

  throw new Error(`工具往返超過上限（${maxRounds} 輪），請把問題問具體一點`);
}

/** 供 AI 技能顯示「這輪用了哪些工具」。 */
export function describeToolNames(calls: ToolCall[]): string {
  const names: Record<string, string> = {
    get_weather: "查天氣",
    get_stock: "查股價",
    get_exchange_rate: "查匯率",
  };
  return calls.map((c) => names[c.name] ?? c.name).join("、");
}

/** 從最後一則 assistant 取純文字（記憶用）。 */
export function lastAssistantText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m.content));
  return last ? textOf(last.content) : "";
}
