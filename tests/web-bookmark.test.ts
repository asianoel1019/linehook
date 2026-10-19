import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bookmarkSkill, { extractTitle, renderList, normalizeBookmark, checkLinks } from "../src/skills/web-bookmark/index.js";
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
    assert.equal(extractTitle("<html><head><title>  ImHook   測試  </title></head></html>"), "ImHook 測試");
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
    assert.deepEqual((h.bookmarks()[0] as { tags: string[] }).tags, ["工具"]);

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
    // 用 127.0.0.1：onTask 附帶的連結檢查會被 SSRF 阻擋立即失敗，測試不需網路。
    const bookmarks = Array.from({ length: 520 }, (_, i) => ({ id: String(i), url: `http://127.0.0.1:1/${i}` }));
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

describe("web-bookmark 多標籤", () => {
  const LOCAL = "http://127.0.0.1:1/x";

  it("新增多標籤並顯示", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL} #工具 #重要` });
    assert.match(h.last(), /#工具 #重要/);
    assert.deepEqual((h.bookmarks()[0] as { tags: string[] }).tags, ["工具", "重要"]);
    await bookmarkSkill.run({ ...h.ctx, args: "清單" });
    assert.match(h.last(), /#工具 #重要/);
  });

  it("重複網址補標籤（無新標籤維持原樣）", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL} #工具` });
    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL} #重要` });
    assert.match(h.last(), /已補上標籤/);
    assert.equal(h.bookmarks().length, 1);
    assert.deepEqual((h.bookmarks()[0] as { tags: string[] }).tags, ["工具", "重要"]);
    await bookmarkSkill.run({ ...h.ctx, args: LOCAL });
    assert.match(h.last(), /已經收藏過這個網址了/);
  });

  it("標籤篩選與標籤一覽", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL}/a #工具` });
    await bookmarkSkill.run({ ...h.ctx, args: `${LOCAL}/b #閱讀` });
    await bookmarkSkill.run({ ...h.ctx, args: "#工具" });
    assert.match(h.last(), /#工具（1 筆）/);
    assert.doesNotMatch(h.last(), /閱讀/);
    await bookmarkSkill.run({ ...h.ctx, args: "#沒有這標籤" });
    assert.match(h.last(), /沒有收藏/);
    await bookmarkSkill.run({ ...h.ctx, args: "標籤" });
    assert.match(h.last(), /#工具（1）/);
    assert.match(h.last(), /#閱讀（1）/);
  });

  it("normalizeBookmark：舊單標籤遷移", () => {
    const n = normalizeBookmark({ id: "1", url: "https://x", title: "X", tag: "工具" } as never);
    assert.deepEqual(n.tags, ["工具"]);
    assert.ok(!("tag" in n));
  });

  it("renderList 標示失效", () => {
    const s = renderList([
      { id: "1", url: "https://x", title: "X", tags: ["工具"], deadSince: 123 } as never,
    ]);
    assert.ok(s.includes("#工具（連結失效）"));
  });
});

describe("web-bookmark 失效檢查", () => {
  const savedFetch = globalThis.fetch;
  const afterEachReset = () => {
    globalThis.fetch = savedFetch;
  };

  it("checkLinks：壞連標記、好連恢復", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("127.0.0.1")) throw new Error("blocked");
      return new Response("ok");
    }) as typeof fetch;
    try {
      // 8.8.8.8 是 IP 字面：assertPublicUrl 的 DNS lookup 不發包即可通過，fetch 走 stub。
      const items = [
        normalizeBookmark({ id: "a", url: "http://127.0.0.1:1/bad", title: "壞", tags: [] } as never),
        normalizeBookmark({ id: "b", url: "https://8.8.8.8/good", title: "好", tags: [], deadSince: 1 } as never),
      ];
      const { items: out, result } = await checkLinks(items, 10);
      assert.equal(result.checked, 2);
      assert.deepEqual(result.newlyDead, ["壞"]);
      assert.equal(result.revived, 1);
      assert.ok(out[0].deadSince);
      assert.equal(out[1].deadSince, null);
    } finally {
      afterEachReset();
    }
  });

  it("收藏 檢查 回報摘要", async () => {
    const h = harness();
    await bookmarkSkill.run({ ...h.ctx, args: "http://127.0.0.1:1/x" });
    globalThis.fetch = (async () => {
      throw new Error("blocked");
    }) as typeof fetch;
    try {
      await bookmarkSkill.run({ ...h.ctx, args: "檢查" });
      assert.match(h.last(), /檢查了 1 筆/);
      assert.match(h.last(), /新發現失效 1 筆/);
    } finally {
      afterEachReset();
    }
  });
});
