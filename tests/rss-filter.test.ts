import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestAtOf, filterItems, nextDigestRun, parseFilters } from "../src/skills/rss/index.js";
import type { FeedItem } from "../src/skills/rss/index.js";

const item = (title: string): FeedItem => ({ title, link: `https://x/${encodeURIComponent(title)}`, date: "" });

describe("rss parseFilters", () => {
  it("解析含/排除/摘要", () => {
    const f = parseFilters("含:apple,台積電 排除:rumor 摘要");
    assert.deepEqual(f.include, ["apple", "台積電"]);
    assert.deepEqual(f.exclude, ["rumor"]);
    assert.equal(f.digest, true);
  });

  it("沒有前綴就給空條件", () => {
    const f = parseFilters("https://example.com/feed.xml 每晚八點寄");
    assert.deepEqual(f, { include: [], exclude: [], digest: false });
  });
});

describe("rss filterItems", () => {
  const sub = { include: ["台積電"], exclude: ["謠言"] };

  it("include 任一命中才留；exclude 命中就丟", () => {
    const items = [item("台積電法說會"), item("聯發科新聞"), item("台積電謠言滿天飛"), item("Apple 發表會")];
    const out = filterItems(items, sub);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "台積電法說會");
  });

  it("空 include = 全部放行；空 exclude 不過濾", () => {
    const items = [item("隨便什麼都留"), item("另一則")];
    assert.equal(filterItems(items, { include: [], exclude: [] }).length, 2);
  });

  it("比對不分大小寫", () => {
    const out = filterItems([item("APPLE EVENT")], { include: ["apple"], exclude: [] });
    assert.equal(out.length, 1);
  });
});

describe("rss digestAtOf / nextDigestRun", () => {
  it("預設 08:00；支援全形冒號", () => {
    assert.equal(digestAtOf({}), "08:00");
    assert.equal(digestAtOf({ digestAt: "7：05" }), "07:05");
    assert.equal(digestAtOf({ digestAt: "壞的" }), "08:00");
  });

  it("nextDigestRun 回未來的時間戳", () => {
    const now = Date.now();
    const next = nextDigestRun("08:00", now);
    assert.ok(next > now);
    assert.ok(next - now <= 24 * 60 * 60 * 1000);
  });
});
