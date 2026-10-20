import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatGoldLine } from "../src/skills/morning/index.js";

describe("morning formatGoldLine", () => {
  it("正常：美元價＋漲跌＋台錢換算", () => {
    // 4120 × 32.5 / 8.294 ≈ 16144.56
    assert.equal(formatGoldLine(4120, 4100, 32.5), "黃金 US$4,120 ▲+0.49%（約NT$16,144/錢）");
  });

  it("下跌與無匯率", () => {
    assert.equal(formatGoldLine(4000, 4100, 32.5), "黃金 US$4,000 ▼-2.44%（約NT$15,674/錢）");
    assert.equal(formatGoldLine(4000, 4100, undefined), "黃金 US$4,000 ▼-2.44%");
    assert.equal(formatGoldLine(4000, undefined, 32.5), "黃金 US$4,000（約NT$15,674/錢）");
  });

  it("無價格回暫無資料", () => {
    assert.equal(formatGoldLine(undefined, 4100, 32.5), "黃金：暫無資料");
    assert.equal(formatGoldLine(NaN, 4100, 32.5), "黃金：暫無資料");
  });
});
