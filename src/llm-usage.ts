import { getCounters } from "./metrics.js";

/** LLM 用量彙總（K5）：由 metrics counter 依 skill/provider/model 聚合，附費用估算。 */
export interface LlmUsageRow {
  skill: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** 每 1M tokens 美元單價（unknown 模型為 null，僅回 tokens）。 */
  costUsd: number | null;
}

export interface LlmUsageReport {
  rows: LlmUsageRow[];
  totalTokens: number;
  totalCostUsd: number | null;
  priced: boolean;
}

/** 已知單價（USD / 1M tokens：輸入 / 輸出）；未列入的模型不估算金額。 */
const PRICES: Record<string, [number, number]> = {
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1": [2, 8],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-flash": [0.075, 0.3],
};

function priceOf(model: string): [number, number] | null {
  if (PRICES[model]) return PRICES[model];
  for (const key of Object.keys(PRICES)) {
    if (model.includes(key)) return PRICES[key];
  }
  return null;
}

export function llmUsage(): LlmUsageReport {
  const grouped = new Map<string, LlmUsageRow>();
  let totalTokens = 0;
  let totalCost = 0;
  let anyPriced = false;

  for (const counter of getCounters()) {
    if (counter.name !== "llm_tokens_total" && counter.name !== "llm_calls_total") continue;
    const { skill = "unknown", provider = "unknown", model = "unknown" } = counter.labels;
    const key = `${skill}|${provider}|${model}`;
    let row = grouped.get(key);
    if (!row) {
      const price = priceOf(model);
      row = {
        skill,
        provider,
        model,
        promptTokens: 0,
        completionTokens: 0,
        calls: 0,
        costUsd: price ? 0 : null,
      };
      grouped.set(key, row);
    }
    if (counter.name === "llm_calls_total") {
      row.calls += counter.value;
      continue;
    }
    if (counter.labels.kind === "prompt") row.promptTokens += counter.value;
    else row.completionTokens += counter.value;
  }

  const rows = [...grouped.values()];
  for (const row of rows) {
    const tokens = row.promptTokens + row.completionTokens;
    totalTokens += tokens;
    if (row.costUsd !== null) {
      const price = priceOf(row.model);
      if (price) {
        row.costUsd = (row.promptTokens / 1_000_000) * price[0] + (row.completionTokens / 1_000_000) * price[1];
        totalCost += row.costUsd;
        anyPriced = true;
      } else {
        row.costUsd = null;
      }
    }
  }
  rows.sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
  return {
    rows,
    totalTokens,
    totalCostUsd: anyPriced ? Math.round(totalCost * 10000) / 10000 : null,
    priced: anyPriced,
  };
}
