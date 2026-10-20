import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatGoldLine, formatFxLine } from "../src/skills/morning/index.js";

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

describe("morning formatFxLine", () => {
  it("美金／日幣／人民幣", () => {
    // 日幣 32.5/156.2≈0.2081；人民幣 32.5/7.24≈4.4890
    assert.equal(formatFxLine(32.5, 156.2, 7.24), "美金 32.50／日幣 0.2081／人民幣 4.4890");
  });

  it("缺幣別時只顯示有的；全缺回暫無資料", () => {
    assert.equal(formatFxLine(32.5, undefined, undefined), "美金 32.50");
    assert.equal(formatFxLine(32.5, 0, NaN), "美金 32.50");
    assert.equal(formatFxLine(undefined, 156.2, 7.24), "匯率：暫無資料");
  });
});
