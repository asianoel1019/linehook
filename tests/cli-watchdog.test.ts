import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWatchedProcess } from "../src/skills/llm.js";
import { withSendTimeout } from "../src/line/client.js";

const NODE = process.execPath;

describe("看門狗 spawn（CLI 逾時保證結案）", () => {
  it("正常結束回 code/out", async () => {
    const r = await runWatchedProcess(NODE, ["-e", "console.log('hi')"], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: 10_000,
      label: "test",
    });
    assert.equal(r.code, 0);
    assert.equal(r.signal, null);
    assert.ok(r.out.includes("hi"));
  });

  it("spawn 失敗直接 reject（ENOENT）", async () => {
    await assert.rejects(
      runWatchedProcess("/no/such/bin-xyz", [], { cwd: process.cwd(), env: {}, timeoutMs: 2000, label: "test" }),
      /ENOENT/,
    );
  });

  it("無視 SIGTERM 也會被升級終止（signal 結案）", async () => {
    const start = Date.now();
    const r = await runWatchedProcess(NODE, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: 400,
      label: "test",
    });
    assert.ok(r.signal === "SIGTERM" || r.signal === "SIGKILL");
    assert.ok(Date.now() - start < 8000, "應在數秒內結案，而非等到 child 自己結束");
  });

  it("pipe 被孫行程咬住時一定結案（Linux 走 finale reject；Windows 關 pipe 即 close）", async () => {
    const start = Date.now();
    const outcome = await runWatchedProcess(
      NODE,
      [
        "-e",
        "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:'inherit'});g.unref();setTimeout(()=>{},60000);",
      ],
      { cwd: process.cwd(), env: process.env as Record<string, string>, timeoutMs: 200, label: "test-cli" },
    ).then(
      (r) => ({ settled: "resolved" as const, signal: r.signal }),
      (e: unknown) => ({ settled: "rejected" as const, message: String((e as Error)?.message ?? e) }),
    );
    assert.ok(Date.now() - start < 20000, "一定要在有限時間內結案");
    if (process.platform === "win32") {
      // Windows：父行程被殺即關 pipe，close 先到
      assert.equal(outcome.settled, "resolved");
    } else {
      // Linux：pipe 被孫行程咬住，finale 接管 reject
      assert.equal(outcome.settled, "rejected");
      assert.ok(outcome.settled === "rejected" && outcome.message.includes("無回應"));
    }
  });
});

describe("withSendTimeout（單則發送逾時）", () => {
  it("本體快就用本體的", async () => {
    assert.equal(await withSendTimeout(Promise.resolve("ok"), 1000, "x"), "ok");
  });

  it("逾時丟錯，本體晚到無害（無 unhandled rejection）", async () => {
    let lateSettled = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        lateSettled = true;
        resolve("late");
      }, 50);
    });
    await assert.rejects(withSendTimeout(slow, 10, "傳送逾時"), /傳送逾時/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lateSettled, true);
  });
});
