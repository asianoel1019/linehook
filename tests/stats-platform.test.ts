import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getStats, recordSend, initStats } from "../src/stats.js";

initStats();

describe("getStats 平台過濾", () => {
  it("依平台分開統計，未標記視為 line", () => {
    // 用專屬平台名避免與其他測試檔共用的記憶體 buffer 互相污染。
    const tag = "t-" + Date.now();
    recordSend({ time: new Date().toISOString(), to: "a", type: "text", ok: true, platform: tag });
    recordSend({ time: new Date().toISOString(), to: "b", type: "text", ok: false, platform: tag });
    recordSend({ time: new Date().toISOString(), to: "c", type: "text", ok: true, platform: tag + "-x" });

    const mine = getStats(14, tag);
    const other = getStats(14, tag + "-x");

    assert.equal(mine.total, 2);
    assert.equal(mine.ok, 1);
    assert.equal(mine.fail, 1);
    assert.equal(other.total, 1);
    assert.equal(other.ok, 1);
  });

  it("不存在的平台回傳 0", () => {
    const s = getStats(14, "no-such-platform-xyz");
    assert.equal(s.total, 0);
    assert.equal(s.successRate, 0);
  });
});
