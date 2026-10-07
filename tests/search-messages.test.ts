import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { recordMessage, searchMessages } from "../src/messages.js";

before(() => {
  const base = [
    { fromName: "Alice", fromMid: "u1", chatMid: "c1", chatType: "user", text: "Hello world" },
    { fromName: "Bob", fromMid: "u2", chatMid: "c2", chatType: "group", text: "早安大家" },
    { fromName: "Alice", fromMid: "u1", chatMid: "c1", chatType: "user", text: "晚安" },
  ];
  base.forEach((m, i) => recordMessage({ ...m, time: `2026-01-0${i + 1}T00:00:00` }));
});

describe("searchMessages", () => {
  it("無條件回傳新到舊、上限 1000", () => {
    const list = searchMessages();
    assert.ok(list.length >= 3);
    assert.ok(list[0].time >= list[1].time);
  });

  it("關鍵字不分大小寫", () => {
    assert.equal(searchMessages({ q: "hello" }).length, 1);
    assert.equal(searchMessages({ q: "HELLO" }).length, 1);
    assert.equal(searchMessages({ q: "早安" }).length, 1);
    assert.equal(searchMessages({ q: "不存在的xyz" }).length, 0);
  });

  it("比對來源與對話欄位", () => {
    assert.equal(searchMessages({ q: "alice" }).length, 2);
    assert.equal(searchMessages({ q: "u2" }).length, 1);
  });

  it("chat 過濾", () => {
    const list = searchMessages({ chat: "c1" });
    assert.ok(list.length >= 2);
    assert.ok(list.every((m) => m.chatMid === "c1"));
  });

  it("limit 上下限", () => {
    assert.equal(searchMessages({ limit: 1 }).length, 1);
    assert.ok(searchMessages({ limit: 99999 }).length <= 1000);
    assert.ok(searchMessages({ limit: -5 }).length >= 1);
  });

  it("日期區間過濾（含當日），支援斜線格式與無效值不設限", () => {
    assert.equal(searchMessages({ since: "2026-01-02" }).length, 2);
    assert.equal(searchMessages({ until: "2026-01-02" }).length, 2);
    assert.equal(searchMessages({ since: "2026-01-02", until: "2026-01-02" }).length, 1);
    assert.equal(searchMessages({ since: "2026-01-04" }).length, 0);
    assert.equal(searchMessages({ until: "2025-12-31" }).length, 0);
    assert.equal(searchMessages({ since: "2026/01/01", until: "2026/01/01" }).length, 1);
    assert.equal(searchMessages({ since: "亂寫" }).length, 3);
  });

  it("平台（chatType）過濾與組合條件", () => {
    assert.equal(searchMessages({ chatType: "group" }).length, 1);
    assert.equal(searchMessages({ chatType: "user" }).length, 2);
    assert.equal(searchMessages({ chatType: "telegram" }).length, 0);
    assert.equal(searchMessages({ chatType: "user", since: "2026-01-02" }).length, 1);
    assert.equal(searchMessages({ chatType: "group", q: "大家" }).length, 1);
  });

  it("limit 0 或未設＝預設上限（不退化成 1 筆）", () => {
    assert.equal(searchMessages({ limit: 0 }).length, 3);
    assert.equal(searchMessages({ limit: undefined }).length, 3);
    assert.equal(searchMessages({ limit: -5 }).length, 3);
    assert.equal(searchMessages({ limit: 1 }).length, 1);
  });

  it("時間戳區間（sinceTs/untilTs，ISO 或 epoch 毫秒）", () => {
    assert.equal(searchMessages({ sinceTs: "2026-01-02T00:00:00" }).length, 2);
    assert.equal(searchMessages({ untilTs: "2026-01-02T00:00:00" }).length, 2);
    assert.equal(searchMessages({ sinceTs: "2026-01-02T00:00:00", untilTs: "2026-01-02T00:00:00" }).length, 1);
    assert.equal(searchMessages({ sinceTs: String(Date.parse("2026-01-02T00:00:00")) }).length, 2, "epoch 毫秒");
    assert.equal(searchMessages({ sinceTs: "2026-01-02T00:00:00", chatType: "user" }).length, 1);
    assert.equal(searchMessages({ sinceTs: "不是時間" }).length, 3, "無效值視為不設限");
    assert.equal(searchMessages({ sinceTs: "2026-01-04T00:00:00" }).length, 0);
  });
});
