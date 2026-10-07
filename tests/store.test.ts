import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { JsonlStore } from "../src/store/jsonl-store.js";
import { SqliteStore } from "../src/store/sqlite-store.js";

let dir = "";
const saved = {
  messagesPath: config.messagesPath,
  statsPath: config.statsPath,
  deadletterPath: config.deadletterPath,
  dbPath: config.dbPath,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-"));
  config.messagesPath = join(dir, "messages.jsonl");
  config.statsPath = join(dir, "stats.jsonl");
  config.deadletterPath = join(dir, "deadletter.jsonl");
  config.dbPath = join(dir, "imweb.db");
});

afterEach(() => {
  config.messagesPath = saved.messagesPath;
  config.statsPath = saved.statsPath;
  config.deadletterPath = saved.deadletterPath;
  config.dbPath = saved.dbPath;
  rmSync(dir, { recursive: true, force: true });
});

const msg = (time: string, text: string, chatMid = "c1") => ({
  time, fromMid: "u1", fromName: "Alice", chatMid, chatType: "user", text,
});

/** 兩個實作跑同一組行為，確保介面等價。 */
function bothBehaviors(make: () => import("../src/store/types.js").Store, label: string) {
  describe(`${label}：核心行為`, () => {
    it("append → query 新到舊 + search/chat/limit", () => {
      const store = make();
      store.append("messages", msg("2026-01-01T00:00:00", "Hello world"));
      store.append("messages", msg("2026-01-02T00:00:00", "早安大家", "c2"));
      store.append("messages", msg("2026-01-03T00:00:00", "晚安"));

      const all = store.query("messages");
      assert.equal(all.length, 3);
      assert.ok(all[0].time >= all[1].time, "新到舊");

      assert.equal(store.query("messages", { search: "hello" }).length, 1);
      assert.equal(store.query("messages", { search: "HELLO" }).length, 1);
      assert.equal(store.query("messages", { search: "早安" }).length, 1);
      assert.equal(store.query("messages", { search: "u1" }).length, 3, "fromMid 可搜");
      assert.equal(store.query("messages", { chat: "c2" }).length, 1);
      assert.equal(store.query("messages", { limit: 2 }).length, 2);
      store.close();
    });

    it("query 依日期區間與 chatType 過濾", () => {
      const store = make();
      store.append("messages", { ...msg("2026-01-01T00:00:00", "a"), chatType: "line" });
      store.append("messages", { ...msg("2026-01-02T00:00:00", "b"), chatType: "telegram" });
      store.append("messages", { ...msg("2026-01-03T00:00:00", "c"), chatType: "line" });

      assert.equal(store.query("messages", { sinceDate: "2026-01-02" }).length, 2);
      assert.equal(store.query("messages", { untilDate: "2026-01-02" }).length, 2);
      assert.equal(
        store.query("messages", { sinceDate: "2026-01-02", untilDate: "2026-01-02" }).length,
        1,
      );
      assert.equal(store.query("messages", { chatType: "line" }).length, 2);
      assert.equal(store.query("messages", { chatType: "telegram" }).length, 1);
      assert.equal(store.query("messages", { chatType: "telegram", sinceDate: "2026-01-03" }).length, 0);
      assert.equal(
        store.query("messages", { sinceDate: "2026-01-01", untilDate: "2026-01-03", chatType: "line" }).length,
        2,
      );
      store.close();
    });

    it("count / groupCount（sends）", () => {
      const store = make();
      store.append("sends", { time: "2026-01-01T00:00:00.000Z", to: "a", type: "text", ok: true, platform: "line" });
      store.append("sends", { time: "2026-01-02T00:00:00.000Z", to: "b", type: "image", ok: false, platform: "telegram" });
      store.append("sends", { time: "2026-01-03T00:00:00.000Z", to: "c", type: "text", ok: true, platform: "telegram" });

      const total = store.count("sends");
      assert.deepEqual(total, { total: 3, ok: 2, fail: 1 });
      const tg = store.count("sends", { platform: "telegram" });
      assert.deepEqual(tg, { total: 2, ok: 1, fail: 1 });
      assert.deepEqual(store.groupCount("sends", "type"), { text: 2, image: 1 });
      assert.deepEqual(store.groupCount("sends", "type", { platform: "telegram" }), { text: 1, image: 1 });
      assert.deepEqual(store.groupCount("sends", "DROP TABLE"), {}, "非法欄位白名單擋下");
      store.close();
    });

    it("prune 依時間刪除；purge 清空", () => {
      const store = make();
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const fresh = new Date().toISOString();
      store.append("messages", msg(old, "太舊了"));
      store.append("messages", msg(fresh, "保留我"));
      const removed = store.prune("messages", { retentionDays: 30 });
      assert.equal(removed, 1);
      assert.equal(store.query("messages", { limit: 100 }).length, 1);
      assert.equal(store.prune("messages", { retentionDays: 0 }), 0, "0 = 不修剪");

      store.purge("messages");
      assert.equal(store.query("messages").length, 0);
      store.close();
    });
  });
}

bothBehaviors(() => new JsonlStore(), "JsonlStore");
bothBehaviors(() => new SqliteStore(), "SqliteStore");

describe("SqliteStore 遷移", () => {
  it("表為空時把既有 JSONL 匯入並改名 .migrated", () => {
    mkdirSync(join(dir, ".."), { recursive: true });
    appendFileSync(
      config.messagesPath,
      [
        JSON.stringify({ time: "2026-02-01T00:00:00", fromMid: "u9", fromName: "Old", chatMid: "c9", chatType: "user", text: "舊資料" }),
        "",
      ].join("\n"),
      "utf8",
    );
    const store = new SqliteStore();
    const rows = store.query("messages", { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "舊資料");
    assert.equal(existsSync(config.messagesPath), false, "已改名");
    assert.ok(existsSync(`${config.messagesPath}.migrated`), "保留 .migrated 封存");
    store.close();

    // 再開一次不重複匯入
    const again = new SqliteStore();
    assert.equal(again.query("messages", { limit: 10 }).length, 1);
    again.close();
  });
});
