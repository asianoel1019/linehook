import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import {
  checkChatBudget,
  flushLlmBudget,
  getChatUsageToday,
  recordChatUsage,
  resetLlmBudgetCache,
  setLlmBudgetPath,
} from "../src/llm-budget.js";
import { assertChatBudget } from "../src/skills/llm.js";

const savedTokCap = config.llmBudgetTokensPerChatDay;
const savedUsdCap = config.llmBudgetUsdPerChatDay;

after(() => {
  config.llmBudgetTokensPerChatDay = savedTokCap;
  config.llmBudgetUsdPerChatDay = savedUsdCap;
  setLlmBudgetPath(null);
  resetLlmBudgetCache();
});

function freshPath(tag: string): string {
  const p = join(tmpdir(), `llm-budget-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  resetLlmBudgetCache();
  setLlmBudgetPath(p);
  return p;
}

describe("P0-2 對話級 LLM 預算", () => {
  it("記帳＋今日彙總（含金額與次數）", () => {
    freshPath("basic");
    config.llmBudgetTokensPerChatDay = 0;
    config.llmBudgetUsdPerChatDay = 0;
    recordChatUsage("c1", 100, 50, 0.01);
    recordChatUsage("c1", 200, 0, null);
    const u = getChatUsageToday("c1");
    assert.equal(u.promptTokens, 300);
    assert.equal(u.completionTokens, 50);
    assert.equal(u.totalTokens, 350);
    assert.equal(u.costUsd, 0.01);
    assert.equal(u.calls, 2);
    assert.deepEqual(getChatUsageToday("nobody"), {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: null,
      calls: 0,
    });
  });

  it("token 上限：超限擋下＋文案可回使用者", () => {
    freshPath("tokcap");
    recordChatUsage("c2", 100, 0, null);
    config.llmBudgetTokensPerChatDay = 50;
    config.llmBudgetUsdPerChatDay = 0;
    const c = checkChatBudget("c2");
    assert.equal(c.ok, false);
    assert.ok((c.reason ?? "").includes("已達上限"));
    assert.throws(() => assertChatBudget({ skill: "ai", chat: "c2" }), /已達上限/);
    config.llmBudgetTokensPerChatDay = 0;
    assert.equal(checkChatBudget("c2").ok, true);
  });

  it("金額上限：無定價模型不誤擋", () => {
    freshPath("usdcap");
    recordChatUsage("c3", 999999, 0, null);
    config.llmBudgetTokensPerChatDay = 0;
    config.llmBudgetUsdPerChatDay = 5;
    assert.equal(checkChatBudget("c3").ok, true);
    recordChatUsage("c3", 0, 0, 10);
    assert.equal(checkChatBudget("c3").ok, false);
  });

  it("無 chat 標記不擋", () => {
    assert.equal(checkChatBudget(undefined).ok, true);
    assert.doesNotThrow(() => assertChatBudget(undefined));
    assert.doesNotThrow(() => assertChatBudget({ skill: "ai" }));
  });

  it("flush 落檔＋重載一致", () => {
    const p = freshPath("persist");
    recordChatUsage("c4", 10, 5, 0.001);
    assert.equal(existsSync(p), false);
    flushLlmBudget();
    assert.equal(existsSync(p), true);
    resetLlmBudgetCache();
    assert.equal(getChatUsageToday("c4").totalTokens, 15);
  });

  it("損壞檔案回空表不炸", () => {
    const p = freshPath("corrupt");
    writeFileSync(p, "[[[", "utf8");
    assert.equal(getChatUsageToday("c4").totalTokens, 0);
    assert.equal(checkChatBudget("c4").ok, true);
  });
});
