import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { SendScheduler } from "../src/line/scheduler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir = "";
let savedDeadletter = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-core-"));
  savedDeadletter = config.deadletterPath;
  config.deadletterPath = join(dir, "deadletter.jsonl");
});

afterEach(() => {
  config.deadletterPath = savedDeadletter;
  rmSync(dir, { recursive: true, force: true });
});

const schedPath = () => join(dir, `s-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

describe("SendScheduler core", () => {
  it("一次性任務觸發後移除", async () => {
    const sent: string[] = [];
    const s = new SendScheduler(async (inputs) => { sent.push(inputs[0].to); }, undefined, schedPath());
    s.add([{ to: "u1", text: "hi" }], Date.now() + 50);
    await sleep(300);
    assert.deepEqual(sent, ["u1"]);
    assert.equal(s.list().length, 0);
    s.stop();
  });

  it("失敗的一次性任務保留並標記 lastError", async () => {
    let fail = true;
    const s = new SendScheduler(async () => {
      if (fail) throw new Error("boom");
    }, undefined, schedPath());
    const view = s.add([{ to: "u1", text: "hi" }], Date.now() + 50);
    await sleep(300);
    const kept = s.list().find((j) => j.id === view.id);
    assert.ok(kept, "失敗任務應保留");
    assert.equal(kept?.lastError, "boom");
    // 死信檔有紀錄
    const lines = readFileSync(config.deadletterPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).error, "boom");
    // 重新排期清除 lastError 並可成功送出
    fail = false;
    const updated = s.update(view.id, { runAt: Date.now() + 50 });
    assert.equal(updated?.lastError, undefined);
    await sleep(300);
    assert.equal(s.list().length, 0);
    s.stop();
  });

  it("update/cancel 找不到回傳 null/false；add 參數錯誤丟錯", async () => {
    const s = new SendScheduler(async () => {}, undefined, schedPath());
    assert.equal(s.update("nope", { runAt: Date.now() }), null);
    assert.equal(s.cancel("nope"), false);
    assert.throws(() => s.add([{ to: "u1", text: "x" }], Date.now(), "not-a-cron"), /無效的排程|解析|cron/);
    assert.throws(
      () => s.add([], Date.now(), undefined, { skillId: "s", task: "t", chat: "c", args: {}, state: {} }),
      /repeat/,
    );
    s.stop();
  });

  it("遞迴任務執行後推進下次時間", async () => {
    let count = 0;
    const s = new SendScheduler(async () => { count++; }, undefined, schedPath());
    const view = s.add([{ to: "u1", text: "tick" }], Date.now() + 50, "* * * * *");
    await sleep(300);
    assert.equal(count, 1);
    const after = s.list().find((j) => j.id === view.id);
    assert.ok(after, "遞迴任務應保留");
    assert.ok(new Date(after!.runAt).getTime() > Date.now());
    assert.equal(after?.lastError, undefined);
    s.stop();
  });

  it("misfire：24h 內過期任務補發，超期寫死信丟棄", async () => {
    const sent: string[] = [];
    const path = schedPath();
    const now = Date.now();
    writeFileSync(path, JSON.stringify([
      { id: "old-recent", runAt: now - 3600_000, inputs: [{ to: "u1", text: "補發我" }], to: ["u1"], summary: "recent", createdAt: now - 3600_000 },
      { id: "old-ancient", runAt: now - 25 * 3600_000, inputs: [{ to: "u2", text: "別發我" }], to: ["u2"], summary: "ancient", createdAt: now - 25 * 3600_000 },
    ]));
    const s = new SendScheduler(async (inputs) => { sent.push(inputs[0].to); }, undefined, path);
    await sleep(300);
    assert.deepEqual(sent, ["u1"]);
    assert.equal(s.list().length, 0);
    const dl = readFileSync(config.deadletterPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(dl.some((d) => d.kind === "scheduled-misfired" && d.to[0] === "u2"));
    s.stop();
  });

  it("損毀的排程檔不炸、保留空排程", async () => {
    const path = schedPath();
    writeFileSync(path, "not-json{{{");
    const s = new SendScheduler(async () => { throw new Error("不該執行"); }, undefined, path);
    await sleep(150);
    assert.equal(s.list().length, 0);
    s.stop();
  });

  it("持久化 roundtrip：重建後恢復未到期任務", async () => {
    const path = schedPath();
    const s1 = new SendScheduler(async () => {}, undefined, path);
    const v = s1.add([{ to: "u9", text: "later" }], Date.now() + 60_000);
    s1.stop();
    const s2 = new SendScheduler(async () => {}, undefined, path);
    const found = s2.list().find((j) => j.id === v.id);
    assert.ok(found);
    assert.deepEqual(found?.to, ["u9"]);
    s2.stop();
  });
});
