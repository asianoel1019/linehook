import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SendQueue, fileQueuePersistence, nextQueueKey } from "../src/line/queue.js";

const workDir = join(tmpdir(), `queue-persist-${process.pid}`);
const fast = () => ({
  maxRetries: 2,
  retryBaseMs: 5,
  minIntervalMs: 0,
  isPermanent: () => false,
});

/** 輪詢等條件成立（取代固定 sleep，負載高時不 flake）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 10));
  }
}

after(() => {
  // 各測試用獨立檔；無全域狀態需清（persistence 由呼叫端傳入）。
});

describe("P0-4 佇列落檔與續送", () => {
  it("enqueue 落檔（含防抖），成功後清掉", async () => {
    const path = join(workDir, "a.json");
    const q = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {},
    });
    const p = q.enqueue("ka", "hello");
    // 防抖 2s 內檔還沒寫；等排水完成（成功即同步寫）後檔應為空陣列
    await p;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(existsSync(path), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
    q.stop();
  });

  it("crash 情境：送一半＋排隊的都留下 → 新實例 start() 續送", async () => {
    const path = join(workDir, "b.json");
    const sent: string[] = [];
    // 第一世：一個卡在半空中（in-flight），一個在排隊；直接「crash」
    const q1 = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {
        await new Promise(() => {}); // 永遠卡住，模擬 crash 前正在送
      },
    });
    q1.enqueue("kb-fly", "flying");
    const queued = q1.enqueue("kb-wait", "waiting");
    await new Promise((r) => setTimeout(r, 50));
    q1.stop();
    await assert.rejects(queued, /已停止/);
    // stop() 同步落檔：在飛的＋排隊的都在（in-flight 的 promise 不會 settle，不等它）
    const saved = JSON.parse(readFileSync(path, "utf8")) as Array<{ key: string }>;
    assert.deepEqual(
      saved.map((t) => t.key),
      ["kb-fly", "kb-wait"],
    );

    // 第二世：建構只載入（pending 含 parked），start() 續送
    const q2 = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async (d) => {
        sent.push(d);
      },
    });
    assert.equal(q2.stats().pending, 2);
    assert.deepEqual(sent, []);
    q2.start();
    await waitFor(() => q2.stats().pending === 0);
    assert.deepEqual(sent, ["flying", "waiting"]);
    q2.stop();
  });

  it("重試計數跨重啟延續（attempts 保留）", async () => {
    const path = join(workDir, "c.json");
    writeFileSync(path, JSON.stringify([{ key: "kc", data: "x", attempts: 2, enqueuedAt: Date.now() }]), "utf8");
    let tries = 0;
    const q = new SendQueue<string>(() => ({ ...fast(), maxRetries: 2 }), {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {
        tries++;
        throw new Error("flaky");
      },
    });
    q.start();
    await waitFor(() => tries >= 1);
    // attempts 已用完（2/2）：只試一次就丟，不重置重試預算
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tries, 1);
    q.stop();
  });

  it("過期（24h+）與重複 key 在載入時丟棄", () => {
    const path = join(workDir, "d.json");
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify([
        { key: "old", data: "x", attempts: 0, enqueuedAt: now - 25 * 3600_000 },
        { key: "dup", data: "x", attempts: 0, enqueuedAt: now },
        { key: "dup", data: "y", attempts: 0, enqueuedAt: now },
        { key: "fresh", data: "z", attempts: 0, enqueuedAt: now },
      ]),
      "utf8",
    );
    const q = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {},
    });
    assert.equal(q.stats().pending, 2); // dup 去重＋old 過期
    q.stop();
  });

  it("start() 冪等：重複呼叫不重送", async () => {
    const path = join(workDir, "e.json");
    writeFileSync(path, JSON.stringify([{ key: "ke", data: "x", attempts: 0, enqueuedAt: Date.now() }]), "utf8");
    let n = 0;
    const q = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {
        n++;
      },
    });
    q.start();
    q.start();
    q.start();
    await waitFor(() => n === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(n, 1);
    q.stop();
  });

  it("損壞的存檔回空陣列不炸", () => {
    const path = join(workDir, "f.json");
    writeFileSync(path, "{oops", "utf8");
    const q = new SendQueue<string>(fast, {
      persistence: fileQueuePersistence<string>(path),
      send: async () => {},
    });
    assert.equal(q.stats().pending, 0);
    q.start();
    q.stop();
  });

  it("nextQueueKey 唯一", () => {
    const keys = new Set([nextQueueKey(), nextQueueKey(), nextQueueKey()]);
    assert.equal(keys.size, 3);
  });
});
