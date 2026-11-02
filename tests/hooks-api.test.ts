import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { registerService } from "../src/messaging/services.js";
import { createServer } from "../src/webhook/server.js";
import type { IMessagingService, SendInput } from "../src/messaging/types.js";
import { resetHookRateWindows, setHooksPath } from "../src/hooks.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const sent: SendInput[] = [];
const scheduled: Array<{ inputs: SendInput[]; runAt: number; repeat?: string }> = [];
const fake: IMessagingService = {
  platform: "line",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (inputs: SendInput[]) => {
    sent.push(...inputs);
  },
  schedule: (inputs: SendInput[], runAt: number, repeat?: string) => {
    scheduled.push({ inputs, runAt, repeat });
    return { id: `job-${scheduled.length}`, runAt: new Date(runAt).toISOString(), repeat: repeat ?? null } as never;
  },
  updateScheduled: () => null,
  listScheduled: () => [],
  cancelScheduled: () => false,
  listTargets: () => [],
  refreshContacts: async () => {},
  getQueueStats: () => ({ pending: 0, running: false }),
  stopListening: () => {},
  stopQueue: () => {},
};

let server: Server;
let base = "";
const savedApiToken = config.apiToken;
const savedApiTokenEnabled = config.apiTokenEnabled;
const savedApiTokens = [...config.apiTokens];

before(async () => {
  registerService(fake);
  config.apiTokenEnabled = true;
  config.apiTokens = [{ name: "t", token: "tok-admin", scopes: ["admin"] }];
  setHooksPath(join(tmpdir(), `hooks-api2-${process.pid}.json`));
  resetHookRateWindows();
  const app = createServer(fake);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  config.apiToken = savedApiToken;
  config.apiTokenEnabled = savedApiTokenEnabled;
  config.apiTokens = savedApiTokens;
  setHooksPath(null);
});

const auth = { Authorization: "Bearer tok-admin" };
const SECRET = "hook-key-123456";

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** 產生重放保護的簽章標頭（timestamp.nonce.body）。 */
function signHeaders(payload: unknown, nonce = `n-${Math.random().toString(36).slice(2)}`): Record<string, string> {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${nonce}.${raw}`).digest("hex");
  return { "Content-Type": "application/json", "X-Hook-Timestamp": ts, "X-Hook-Nonce": nonce, "X-Hook-Signature": sig };
}

describe("跨專案通知閘道：POST /hook/:name（第二階段）", () => {
  it("管理 API：建立 → 列出（secret 遮蔽）→ 刪除", async () => {
    const created = await post("/hooks", {
      name: "ci-failed",
      to: "工作群",
      platform: "line",
      template: "{{repo}} #{{pr}} 失敗",
      secret: SECRET,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body?.ok, true);

    const list = await fetch(`${base}/hooks.json`, { headers: auth });
    const body = (await list.json()) as { hooks: Array<Record<string, unknown>> };
    assert.equal(body.hooks.length, 1);
    assert.equal(body.hooks[0]?.secret, "****", "secret 不該外洩");

    const del = await fetch(`${base}/hooks/ci-failed`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
  });

  it("投遞：渲染範本後送到指定對話（含 timestamp+nonce 簽章）", async () => {
    sent.length = 0;
    await post("/hooks", {
      name: "ci-failed",
      to: "工作群",
      platform: "line",
      template: "{{repo}} #{{pr}} 失敗：{{reason}}",
      secret: SECRET,
    });
    const payload = { repo: "proj/api", pr: 4213, reason: "3 tests failed" };
    const res = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, "工作群");
    assert.equal(sent[0]?.text, "proj/api #4213 失敗：3 tests failed");
  });

  it("重放保護：nonce 重複 → 403", async () => {
    sent.length = 0;
    const payload = { repo: "x", pr: 1 };
    const headers = signHeaders(payload, "fixed-nonce-1");
    const first = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(second.status, 403);
    assert.equal(sent.length, 1, "重放不該再送一次");
  });

  it("重放保護：缺 timestamp／過期 timestamp → 403", async () => {
    const payload = { repo: "x" };
    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    const noTs = await fetch(`${base}/hook/ci-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": sig },
      body: raw,
    });
    assert.equal(noTs.status, 403);
    const oldTs = String(Math.floor(Date.now() / 1000) - 99999);
    const oldSig = crypto.createHmac("sha256", SECRET).update(`${oldTs}.n2.${raw}`).digest("hex");
    const expired = await fetch(`${base}/hook/ci-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Timestamp": oldTs, "X-Hook-Nonce": "n2", "X-Hook-Signature": oldSig },
      body: raw,
    });
    assert.equal(expired.status, 403);
  });

  it("簽章錯誤：403 且不投遞", async () => {
    sent.length = 0;
    const res = await fetch(`${base}/hook/ci-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": "deadbeef" },
      body: JSON.stringify({ repo: "x" }),
    });
    assert.equal(res.status, 403);
    assert.equal(sent.length, 0);
  });

  it("冪等：同一 Idempotency-Key 只送一次（重試會重新簽名、nonce 換新）", async () => {
    sent.length = 0;
    const payload = { repo: "proj/api", pr: 7 };
    const raw = JSON.stringify(payload);
    // 第一次
    const h1 = { ...signHeaders(payload), "Idempotency-Key": "build-7" };
    const r1 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers: h1, body: raw });
    const b1 = (await r1.json()) as Record<string, unknown>;
    assert.equal(b1.duplicate, undefined);
    // 重試：同一冪等鍵，但重新簽名（新的 timestamp/nonce）
    const h2 = { ...signHeaders(payload), "Idempotency-Key": "build-7" };
    const r2 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers: h2, body: raw });
    const b2 = (await r2.json()) as Record<string, unknown>;
    assert.equal(b2.duplicate, true);
    assert.equal(sent.length, 1);
  });

  it("重放保護優先於冪等：同一 nonce 重送 → 403", async () => {
    sent.length = 0;
    const payload = { repo: "proj/api", pr: 8 };
    const raw = JSON.stringify(payload);
    const headers = { ...signHeaders(payload, "replay-nonce-1"), "Idempotency-Key": "build-8" };
    const r1 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: raw });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: raw });
    assert.equal(r2.status, 403);
    assert.equal(sent.length, 1);
  });

  it("降噪：未命中 include → skipped 且不投遞", async () => {
    sent.length = 0;
    await post("/hooks", {
      name: "noisy",
      to: "工作群",
      platform: "line",
      template: "{{status}}",
      include: ["failed"],
      secret: SECRET,
    });
    const payload = { status: "passed" };
    const res = await fetch(`${base}/hook/noisy`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.skipped, true);
    assert.equal(sent.length, 0);
  });

  it("排程：body 帶 runAt → 交給 scheduler（不直接送）", async () => {
    sent.length = 0;
    scheduled.length = 0;
    await post("/hooks", {
      name: "later",
      to: "工作群",
      platform: "line",
      template: "稍後提醒：{{what}}",
      secret: SECRET,
    });
    const payload = { what: "喝水", runAt: new Date(Date.now() + 600_000).toISOString() };
    const res = await fetch(`${base}/hook/later`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.scheduled, true);
    assert.equal(scheduled.length, 1);
    assert.equal(sent.length, 0);
    assert.equal(scheduled[0]?.inputs[0]?.text, "稍後提醒：喝水");
  });

  it("非同步：立刻 202，背景投遞後可查狀態", async () => {
    sent.length = 0;
    await post("/hooks", {
      name: "async-hook",
      to: "工作群",
      platform: "line",
      template: "非同步：{{x}}",
      secret: SECRET,
      async: true,
    });
    const payload = { x: "hi" };
    const res = await fetch(`${base}/hook/async-hook`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    assert.equal(res.status, 202);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.accepted, true);
    const deliveryId = body.deliveryId as string;

    // 等背景投遞完成
    for (let i = 0; i < 50; i++) {
      if (sent.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(sent.length, 1);
    const listRes = await fetch(`${base}/hooks/async-hook/deliveries`, { headers: auth });
    const list = (await listRes.json()) as { deliveries: Array<Record<string, unknown>> };
    const rec = list.deliveries.find((d) => d.id === deliveryId);
    assert.ok(rec, "應能查到這筆投遞");
    assert.equal(rec?.status, "delivered");
  });

  it("per-hook 限流：超過上限 → 429", async () => {
    sent.length = 0;
    resetHookRateWindows();
    await post("/hooks", {
      name: "limited",
      to: "工作群",
      platform: "line",
      template: "x",
      secret: SECRET,
      ratePerMin: 2,
    });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const payload = { n: i };
      const res = await fetch(`${base}/hook/limited`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
      codes.push(res.status);
    }
    assert.deepEqual(codes, [200, 200, 429]);
  });

  it("找不到 hook → 404；停用 → 409", async () => {
    const missing = await fetch(`${base}/hook/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 404);

    await post("/hooks", { name: "off-hook", to: "t", platform: "line", disabled: true, secret: SECRET });
    const payload = { a: 1 };
    const res = await fetch(`${base}/hook/off-hook`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    assert.equal(res.status, 409);
  });

  it("渲染後為空 → 400", async () => {
    await post("/hooks", { name: "empty", to: "t", platform: "line", template: "{{missing}}", secret: SECRET });
    const payload = { a: 1 };
    const res = await fetch(`${base}/hook/empty`, { method: "POST", headers: signHeaders(payload), body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
  });
});
