import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bookmarkSkill, { extractTitle, renderList } from "../src/skills/web-bookmark/index.js";
import type { SkillContext } from "../src/skills/types.js";

interface Harness {
  ctx: SkillContext;
  replies: string[];
  last: () => string;
  bookmarks: () => Array<Record<string, unknown>>;
}

function harness(): Harness {
  const replies: string[] = [];
  const states: Record<string, Record<string, unknown>> = {};
  const ctx = {
    text: "",
    args: "",
    fromName: "tester",
    chat: "c1",
    fromMid: "u1",
    config: {},
    reply: async (t: string) => {
      replies.push(t);
    },
    sendImage: async () => {},
    sendFile: async () => {},
    schedule: () => "sched",
    watch: (opts: { task: string; state?: Record<string, unknown> }) => {
      if (opts.state) states[opts.task] = opts.state;
      return `task:${opts.task}`;
    },
    unwatch: () => true,
    watches: () => [],
    taskState: (task: string) => states[task],
  } as unknown as SkillContext;
  return {
    ctx,
    replies,
    last: () => replies[replies.length - 1] ?? "",
    bookmarks: () => (states.bookmarks?.bookmarks ?? []) as Array<Record<string, unknown>>,
  };
}

describe("web-bookmark extractTitle / renderList", () => {
  it("取出 title 並收斂空白", () => {
    assert.equal(extractTitle("<html><head><title>  IM   Webhook </title></head></html>"), "IM Webhook");
    assert.equal(extractTitle("<TITLE>全大寫</TITLE>"), "全大寫");
  });

  it("沒有 title 回空字串，過長會截到 80 字", () => {
    assert.equal(extractTitle("<html><body>無標題</body></html>"), "");
    assert.equal(extractTitle(`<title>${"長".repeat(120)}</title>`).length, 80);
  });

  it("renderList 顯示標籤與網址", () => {
    const list = renderList([
      { id: "1", url: "https://a.example", title: "A 站", tag: "工具", addedBy: "u", addedByName: "n", addedAt: 0 },
      { id: "2", url: "https://b.example", title: "", tag: "", addedBy: "u", addedByName: "n", addedAt: 0 },
    ]);
    assert.equal(list, "1. A 站 #工具\n   https://a.example\n2. https://b.example\n   https://b.example");
    assert.equal(renderList([]), "");
  });
});

describe("web-bookmark run() 流程", () => {
  // 用 127.0.0.1：fetchTitle 會被 SSRF 阻擋（blockPrivate）立即失敗，測試不需網路。
  const LOCAL = "http://127.0.0.1:1/x";

  it("新增 → 清單 → 搜尋 → 刪除", async () => {
    const h = harness();

    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL} #工具` });
    assert.match(h.last(), /^已收藏：/);
    assert.match(h.last(), /#工具/);
    assert.match(h.last(), /共 1 筆收藏/);
    assert.equal(h.bookmarks().length, 1);
    assert.equal(h.bookmarks()[0].tag, "工具");

    await bookmarkSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /收藏清單（共 1 筆）/);
    assert.match(h.last(), /#工具/);

    await bookmarkSkill.run({ ...h.ctx, args: "搜尋 工具" });
    assert.match(h.last(), /搜尋「工具」找到 1 筆/);

    await bookmarkSkill.run({ ...h.ctx, args: "搜尋 找不到的關鍵字" });
    assert.match(h.last(), /沒有結果/);

    await bookmarkSkill.run({ ...h.ctx, args: "刪除 1" });
    assert.match(h.last(), /^已刪除：/);
    assert.equal(h.bookmarks().length, 0);

    await bookmarkSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /目前沒有收藏/);
  });

  it("重複網址不會被收藏兩次", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: LOCAL });
    await bookmarkSkill.run({ ...h.ctx, args: LOCAL });
    assert.match(h.last(), /已經收藏過這個網址了/);
    assert.equal(h.bookmarks().length, 1);
  });

  it("找不到要刪除的項目", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: LOCAL });
    await bookmarkSkill.run({ ...h.ctx, args: "刪除 99" });
    assert.match(h.last(), /找不到「99」/);
    assert.equal(h.bookmarks().length, 1);
  });

  it("沒有網址時提示用法", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: "這不是網址" });
    assert.match(h.last(), /請提供網址/);
    await bookmarkSkill.run({ ...h.ctx, args: "" });
    assert.match(h.last(), /用法：/);
  });

  it("沒有收藏時清單／刪除的提示", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /目前沒有收藏/);
    await bookmarkSkill.run({ ...h.ctx, args: "刪除 1" });
    assert.match(h.last(), /目前沒有收藏/);
  });

  it("onTask 把收藏裁到 500 筆上限", async () => {
    const bookmarks = Array.from({ length: 520 }, (_, i) => ({ id: String(i), url: `https://x/${i}` }));
    let saved: Record<string, unknown> | undefined;
    await bookmarkSkill.onTask!({
      taskId: "t1",
      task: "bookmarks",
      chat: "c1",
      fromName: "n",
      config: {},
      args: {},
      state: { bookmarks },
      saveState: async (patch) => {
        saved = patch;
      },
      reply: async () => {},
      sendImage: async () => {},
      sendFile: async () => {},
    });
    assert.equal((saved?.bookmarks ?? []).length, 500);
  });
});
