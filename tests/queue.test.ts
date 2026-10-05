import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SendQueue } from "../src/line/queue.js";

const fast = () => ({
  maxRetries: 3,
  retryBaseMs: 5,
  minIntervalMs: 0,
  isPermanent: () => false,
});

describe("SendQueue", () => {
  it("依 FIFO 順序執行", async () => {
    const order: number[] = [];
    const q = new SendQueue(fast);
    await Promise.all([
      q.enqueue(async () => { order.push(1); }),
      q.enqueue(async () => { order.push(2); }),
      q.enqueue(async () => { order.push(3); }),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
    q.stop();
  });

  it("暫時性錯誤會重試後成功", async () => {
    let attempts = 0;
    const q = new SendQueue(fast);
    await q.enqueue(async () => {
      attempts++;
      if (attempts < 3) throw new Error("timeout");
    });
    assert.equal(attempts, 3);
    q.stop();
  });

  it("永久性錯誤立即拒絕、不重試", async () => {
    let attempts = 0;
    const q = new SendQueue(() => ({
      ...fast(),
      isPermanent: (e) => e instanceof Error && e.message === "fatal",
    }));
    await assert.rejects(
      q.enqueue(async () => {
        attempts++;
        throw new Error("fatal");
      }),
      /fatal/,
    );
    assert.equal(attempts, 1);
    q.stop();
  });

  it("超過 maxRetries 後拒絕", async () => {
    let attempts = 0;
    const q = new SendQueue(() => ({ ...fast(), maxRetries: 2 }));
    await assert.rejects(
      q.enqueue(async () => {
        attempts++;
        throw new Error("flaky");
      }),
      /flaky/,
    );
    assert.equal(attempts, 3); // 1 初次 + 2 重試
    q.stop();
  });

  it("minIntervalMs 節流發送間隔", async () => {
    const q = new SendQueue(() => ({ ...fast(), minIntervalMs: 120 }));
    const t0 = Date.now();
    await q.enqueue(async () => {});
    await q.enqueue(async () => {});
    assert.ok(Date.now() - t0 >= 100, `間隔過短: ${Date.now() - t0}ms`);
    q.stop();
  });

  it("佇列滿時拒絕新的 enqueue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = new SendQueue(fast);
    const pending: Promise<void>[] = [];
    // 第一個任務卡住 drain（已 shift 出陣列），後面 1000 個填滿佇列
    pending.push(q.enqueue(() => gate));
    for (let i = 0; i < 1000; i++) pending.push(q.enqueue(async () => {}));
    assert.equal(q.stats().pending, 1000);
    await assert.rejects(q.enqueue(async () => {}), /已滿/);
    release();
    await Promise.all(pending);
    q.stop();
  });

  it("stop() 拒絕待處理任務與新的任務", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = new SendQueue(fast);
    const running = q.enqueue(() => gate);
    const queued = q.enqueue(async () => {});
    // 等 drain 開始執行第一個任務
    await new Promise((r) => setTimeout(r, 20));
    q.stop();
    release();
    await running; // 執行中的任務正常完成
    await assert.rejects(queued, /已停止/);
    await assert.rejects(q.enqueue(async () => {}), /已停止/);
  });

  it("stats() 回報 pending 與 running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const q = new SendQueue(fast);
    const p1 = q.enqueue(() => gate);
    const p2 = q.enqueue(async () => {});
    await new Promise((r) => setTimeout(r, 20));
    const s = q.stats();
    assert.equal(s.pending, 1);
    assert.equal(s.running, true);
    release();
    await Promise.all([p1, p2]);
    const s2 = q.stats();
    assert.equal(s2.pending, 0);
    assert.equal(s2.running, false);
    q.stop();
  });
});
