import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWatchedProcess } from "../src/skills/llm.js";
import { withSendTimeout } from "../src/messaging/send-util.js";

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

  it("最終防線：watchdog 一定會把行程收掉（不靠平台差異）", async () => {
    // 忽略 SIGTERM 的行程 → watchdog 必須升級到 SIGKILL，close 帶 signal 回來。
    const start = Date.now();
    const r = await runWatchedProcess(NODE, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      timeoutMs: 300,
      label: "test",
    });
    assert.ok(r.signal === "SIGTERM" || r.signal === "SIGKILL", `應帶終止 signal（實際 ${r.signal}）`);
    assert.ok(Date.now() - start < 15_000, "不該等到行程自己結束");
  });

  it("被孫行程拖住 pipe 也不會卡住：一定在有限時間內結案", async () => {
    // 孫行程繼承 stdout，理論上會拖住 pipe 讓 'close' 不來。
    // 各平台的 fd 繼承/關閉行為不同（Windows 關行程即關 pipe；Linux 也可能），
    // 而且 watchdog 在 SIGTERM 後 3 秒會銷毀 stdio（close 因此會觸發），
    // 所以「resolve 或 reject」不是重點——真正該保證的是「絕不卡住，必在有限時間內結束」。
    const start = Date.now();
    const outcome = await runWatchedProcess(
      NODE,
      [
        "-e",
        "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'inherit'});g.unref();setTimeout(()=>{},60000);",
      ],
      { cwd: process.cwd(), env: process.env as Record<string, string>, timeoutMs: 300, label: "test-cli" },
    ).then(
      (r) => ({ kind: "resolved" as const, signal: r.signal }),
      (e: unknown) => ({ kind: "rejected" as const, message: String((e as Error)?.message ?? e) }),
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 20_000, `不該卡住（跑了 ${elapsed}ms）`);
    if (outcome.kind === "rejected") {
      assert.match(outcome.message, /無回應/);
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
