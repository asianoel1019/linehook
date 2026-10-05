import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordMetric } from "../src/metrics.js";
import { llmUsage } from "../src/llm-usage.js";

describe("llmUsage", () => {
  it("無資料時回空列且不估算金額", () => {
    const r = llmUsage();
    assert.deepEqual(r.rows, []);
    assert.equal(r.totalTokens, 0);
    assert.equal(r.totalCostUsd, null);
    assert.equal(r.priced, false);
  });

  it("依 skill×provider×model 聚合 token 與次數，已知模型估算金額", () => {
    recordMetric("llm_tokens_total", 1_000_000, { skill: "weather", provider: "openai", model: "gpt-4o-mini", kind: "prompt" });
    recordMetric("llm_tokens_total", 500_000, { skill: "weather", provider: "openai", model: "gpt-4o-mini", kind: "completion" });
    recordMetric("llm_calls_total", 3, { skill: "weather", provider: "openai", model: "gpt-4o-mini" });

    const r = llmUsage();
    const row = r.rows.find((x) => x.model === "gpt-4o-mini" && x.skill === "weather");
    assert.ok(row, "應有 gpt-4o-mini/weather 列");
    assert.equal(row.promptTokens, 1_000_000);
    assert.equal(row.completionTokens, 500_000);
    assert.equal(row.calls, 3);
    // 1M prompt × 0.15 + 0.5M completion × 0.6 / 1M = 0.15 + 0.3
    assert.ok(row.costUsd !== null);
    assert.ok(Math.abs(row.costUsd - 0.45) < 1e-9, `cost=${row.costUsd}`);
    assert.equal(r.priced, true);
  });

  it("未知模型只回 token 不估算金額", () => {
    recordMetric("llm_tokens_total", 100, { skill: "x", provider: "openai", model: "mystery-model-9000", kind: "prompt" });
    const r = llmUsage();
    const row = r.rows.find((x) => x.model === "mystery-model-9000");
    assert.ok(row);
    assert.equal(row.costUsd, null);
    assert.equal(row.promptTokens, 100);
  });

  it("清單依 token 總量遞減排序", () => {
    const r = llmUsage();
    const totals = r.rows.map((x) => x.promptTokens + x.completionTokens);
    const sorted = [...totals].sort((a, b) => b - a);
    assert.deepEqual(totals, sorted);
  });
});
