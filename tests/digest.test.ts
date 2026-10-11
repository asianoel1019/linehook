import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeDigestText, type DigestInput } from "../src/monitor/digest.js";

const base: DigestInput = {
  platformHealth: [
    { platform: "line", ok: true },
    { platform: "telegram", ok: false },
  ],
  yesterday: { total: 100, ok: 95, fail: 5 },
  deadletters: 3,
  skills: [
    { skill: "weather", run: 40, failed: 1 },
    { skill: "stock", run: 25, failed: 0 },
    { skill: "rss", run: 10, failed: 0 },
  ],
  llm: { calls: 12, tokens: 54321, costUsd: 0.0123 },
};

describe("composeDigestText", () => {
  it("包含平台、發送、死信、技能、LLM 四段", () => {
    const text = composeDigestText(base, "2026-10-10");
    assert.match(text, /每日摘要（2026-10-10）/);
    assert.match(text, /平台：telegram 異常（共 2 個）/);
    assert.match(text, /發送：100 則（成功 95・失敗 5・成功率 95%）/);
    assert.match(text, /死信：3 筆/);
    assert.match(text, /技能 TOP 3：weather 40（失敗 1）、stock 25、rss 10/);
    assert.match(text, /LLM：12 次呼叫・54,321 tokens・約 \$0\.0123/);
  });

  it("全部平台正常時顯示全部正常", () => {
    const text = composeDigestText({ ...base, platformHealth: [{ platform: "line", ok: true }] }, "d");
    assert.match(text, /平台：全部正常（共 1 個）/);
  });

  it("沒有 LLM 區塊時不出現 LLM 行", () => {
    const text = composeDigestText({ ...base, llm: null }, "d");
    assert.doesNotMatch(text, /LLM：/);
  });

  it("昨日零發送時成功率顯示 0", () => {
    const text = composeDigestText({ ...base, yesterday: { total: 0, ok: 0, fail: 0 } }, "d");
    assert.match(text, /發送：0 則（成功 0・失敗 0・成功率 0%）/);
  });

  it("技能只列前 5 名，且沒有觸發的省略", () => {
    const skills = Array.from({ length: 8 }, (_, i) => ({ skill: `s${i}`, run: 10 - i, failed: 0 }));
    skills.push({ skill: "idle", run: 0, failed: 0 });
    const text = composeDigestText({ ...base, skills }, "d");
    assert.doesNotMatch(text, /s7/);
    assert.doesNotMatch(text, /idle/);
    const empty = composeDigestText({ ...base, skills: [] }, "d");
    assert.match(empty, /技能：昨日無觸發紀錄/);
  });
});
