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
import { setHooksPath } from "../src/hooks.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const sent: SendInput[] = [];
const fake: IMessagingService = {
  platform: "line",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (inputs: SendInput[]) => {
    sent.push(...inputs);
  },
  schedule: () => ({}) as never,
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
  setHooksPath(join(tmpdir(), `hooks-api-${process.pid}.json`));
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("跨專案通知閘道：POST /hook/:name", () => {
  it("管理 API：建立 → 列出（secret 遮蔽）→ 刪除", async () => {
    const created = await post("/hooks", {
      name: "ci-failed",
      to: "工作群",
      platform: "line",
      template: "{{repo}} #{{pr}} 失敗",
      secret: "hook-key-123456",
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

  it("投遞：渲染範本後送到指定對話", async () => {
    sent.length = 0;
    await post("/hooks", {
      name: "ci-failed",
      to: "工作群",
      platform: "line",
      template: "{{repo}} #{{pr}} 失敗：{{reason}}",
      secret: "hook-key-123456",
    });
    const raw = JSON.stringify({ repo: "proj/api", pr: 4213, reason: "3 tests failed" });
    const sig = crypto.createHmac("sha256", "hook-key-123456").update(raw).digest("hex");
    const res = await fetch(`${base}/hook/ci-failed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": sig },
      body: raw,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, "工作群");
    assert.equal(sent[0]?.text, "proj/api #4213 失敗：3 tests failed");
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

  it("冪等：同一 Idempotency-Key 只送一次", async () => {
    sent.length = 0;
    const raw = JSON.stringify({ repo: "proj/api", pr: 7 });
    const sig = crypto.createHmac("sha256", "hook-key-123456").update(raw).digest("hex");
    const headers = { "Content-Type": "application/json", "X-Hook-Signature": sig, "Idempotency-Key": "build-7" };
    const r1 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: raw });
    const b1 = (await r1.json()) as Record<string, unknown>;
    assert.equal(b1.duplicate, undefined);
    const r2 = await fetch(`${base}/hook/ci-failed`, { method: "POST", headers, body: raw });
    const b2 = (await r2.json()) as Record<string, unknown>;
    assert.equal(b2.duplicate, true);
    assert.equal(sent.length, 1, "重複事件不該再送一次");
  });

  it("降噪：未命中 include 時跳過（skipped）", async () => {
    sent.length = 0;
    await post("/hooks", {
      name: "noisy",
      to: "工作群",
      platform: "line",
      template: "{{status}}",
      include: ["failed"],
      secret: "hook-key-123456",
    });
    const raw = JSON.stringify({ status: "passed" });
    const sig = crypto.createHmac("sha256", "hook-key-123456").update(raw).digest("hex");
    const res = await fetch(`${base}/hook/noisy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": sig },
      body: raw,
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.skipped, true);
    assert.equal(sent.length, 0);
  });

  it("找不到 hook → 404；停用 → 409", async () => {
    const missing = await fetch(`${base}/hook/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 404);

    await post("/hooks", { name: "off-hook", to: "t", platform: "line", disabled: true, secret: "k123456" });
    const raw = JSON.stringify({ a: 1 });
    const sig = crypto.createHmac("sha256", "k123456").update(raw).digest("hex");
    const off = await fetch(`${base}/hook/off-hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": sig },
      body: raw,
    });
    assert.equal(off.status, 409);
  });

  it("渲染後為空 → 400", async () => {
    await post("/hooks", { name: "empty", to: "t", platform: "line", template: "{{missing}}", secret: "k123456" });
    const raw = JSON.stringify({ a: 1 });
    const sig = crypto.createHmac("sha256", "k123456").update(raw).digest("hex");
    const res = await fetch(`${base}/hook/empty`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hook-Signature": sig },
      body: raw,
    });
    assert.equal(res.status, 400);
  });
});
