import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEtfSymbol } from "../src/skills/etf-compare/index.js";

describe("etf-compare resolveEtfSymbol", () => {
  it("台股代號自動補 .TW", () => {
    assert.deepEqual(resolveEtfSymbol("ETF 0050 0056 00878"), ["0050.TW", "0056.TW", "00878.TW"]);
    assert.deepEqual(resolveEtfSymbol("12345"), ["12345.TW"]);
  });

  it("美股代號保留原樣並轉大寫", () => {
    assert.deepEqual(resolveEtfSymbol("etf spy qqq"), ["SPY", "QQQ"]);
    assert.deepEqual(resolveEtfSymbol("比較 VTI 與 VXUS"), ["VTI", "VXUS"]);
  });

  it("支援逗號、頓號與混合格式", () => {
    assert.deepEqual(resolveEtfSymbol("0050,SPY、QQQ"), ["0050.TW", "SPY", "QQQ"]);
  });

  it("重複代號只留一筆", () => {
    assert.deepEqual(resolveEtfSymbol("0050 0050 SPY spy"), ["0050.TW", "SPY"]);
  });

  it("最多取 5 檔", () => {
    const out = resolveEtfSymbol("AAA BBB CCC DDD EEE FFF GGG");
    assert.equal(out.length, 5);
    assert.deepEqual(out, ["AAA", "BBB", "CCC", "DDD", "EEE"]);
  });

  it("過濾掉中文與無效字串", () => {
    assert.deepEqual(resolveEtfSymbol("比一比 的 和"), []);
    assert.deepEqual(resolveEtfSymbol("今天天氣"), []);
    assert.deepEqual(resolveEtfSymbol("1234567"), [], "7 碼數字不是代號");
  });

  it("別名詞不會被當成代號", () => {
    assert.deepEqual(resolveEtfSymbol("ETF 與 THE 跟 FOR"), []);
  });
});
