import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySkillError,
  getCounters,
  recordDuration,
  recordMetric,
  renderMetrics,
} from "../src/metrics.js";

describe("metrics histogram 與錯誤分類（P0-1）", () => {
  it("recordDuration：累積桶＋sum＋count", () => {
    recordDuration("p01_test_hist", 0.3, { skill: "a" });
    recordDuration("p01_test_hist", 7, { skill: "a" });
    const out = renderMetrics();
    // 0.3 進 ≤0.5 的桶；7 只進 ≤10 之後的桶
    assert.ok(out.includes('p01_test_hist{skill="a",le="0.1"} 0'));
    assert.ok(out.includes('p01_test_hist{skill="a",le="0.5"} 1'));
    assert.ok(out.includes('p01_test_hist{skill="a",le="5"} 1'));
    assert.ok(out.includes('p01_test_hist{skill="a",le="10"} 2'));
    assert.ok(out.includes('p01_test_hist{skill="a",le="+Inf"} 2'));
    assert.ok(out.includes('p01_test_hist_sum{skill="a"} 7.3'));
    assert.ok(out.includes('p01_test_hist_count{skill="a"} 2'));
  });

  it("recordDuration：非法秒數歸零不炸", () => {
    recordDuration("p01_test_bad", NaN);
    recordDuration("p01_test_bad", -5);
    const out = renderMetrics();
    assert.ok(out.includes('p01_test_bad{le="0.1"} 2'));
    assert.ok(out.includes("p01_test_bad_sum{} 0"));
  });

  it("classifySkillError：各類歸位", () => {
    assert.equal(classifySkillError("AbortError: timeout"), "timeout");
    assert.equal(classifySkillError("請求超時"), "timeout");
    assert.equal(classifySkillError("HTTP 503 Service Unavailable"), "http5xx");
    assert.equal(classifySkillError("HTTP 404 Not Found"), "http4xx");
    assert.equal(classifySkillError("BlockedHostError: 內網位址不允許"), "blocked");
    assert.equal(classifySkillError("fetch failed: ENOTFOUND"), "network");
    assert.equal(classifySkillError("Unexpected token in JSON"), "parse");
    assert.equal(classifySkillError("缺少 CWA API Key"), "config");
    assert.equal(classifySkillError("HTTP 401 Unauthorized"), "http4xx");
    assert.equal(classifySkillError("什麼怪錯"), "other");
  });

  it("counter 行為不變", () => {
    recordMetric("p01_test_counter", 2, { a: "b" });
    const found = getCounters().find((c) => c.name === "p01_test_counter");
    assert.equal(found?.value, 2);
    assert.ok(renderMetrics().includes('p01_test_counter{a="b"} 2'));
  });
});
