import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";import { config } from "../src/config.js";
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

// 檔名帶隨機後綴：Windows 會重用 PID，只用 pid 會撞到上一次的殘留檔。
const hooksFile = join(tmpdir(), `hooks-ui-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

before(async () => {
  registerService(fake);
  config.apiTokenEnabled = true;
  config.apiTokens = [{ name: "t", token: "tok-admin", scopes: ["admin"] }];
  rmSync(hooksFile, { force: true });
  setHooksPath(hooksFile);
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
  rmSync(hooksFile, { force: true });
});

const auth = { Authorization: "Bearer tok-admin" };

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("外部推播入口頁（/hooks）", () => {
  it("GET /hooks：頁面可開且含主要元素", async () => {
    const res = await fetch(`${base}/hooks`, { headers: auth });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("外部推播入口"));
    assert.ok(html.includes('id="hk-name"'));
    assert.ok(html.includes('id="hk-to"'));
    assert.ok(html.includes('id="hk-template"'));
    assert.ok(html.includes('id="hk-secret"'));
    assert.ok(html.includes('id="hk-skill"'));
    assert.ok(html.includes('id="hook-rows"'));
    assert.ok(html.includes('id="hk-preview"'));
    assert.ok(html.includes('id="hk-test-send"'));
    // 導航有入口
    assert.ok(html.includes('href="/hooks"'));
  });

  it("GET /hooks：內嵌 JS 語法有效（模板轉義回歸）", async () => {
    const res = await fetch(`${base}/hooks`, { headers: auth });
    const html = await res.text();
    const m = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, "應有內嵌 script");
    const tmp = join(tmpdir(), `hooks-inline-${process.pid}.js`);
    writeFileSync(tmp, m[1], "utf8");
    try {
      const r = spawnSync(process.execPath, ["--check", tmp]);
      assert.equal(r.status, 0, String(r.stderr).slice(0, 300));
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("POST /hooks：金鑰留空會自動產生並回傳一次", async () => {
    const r = await post("/hooks", { name: "ui-hook", to: "工作群", platform: "line", template: "{{x}}" });
    assert.equal(r.status, 200);
    assert.equal(r.body?.ok, true);
    assert.ok(typeof r.body?.secret === "string");
    assert.ok((r.body?.secret as string).length >= 32);
    assert.equal((r.body?.hook as Record<string, unknown>)?.secret, "****");
  });

  it("POST /hooks/:name/preview：渲染但不送出", async () => {
    sent.length = 0;
    await post("/hooks", { name: "pv", to: "工作群", platform: "line", template: "{{repo}} #{{pr}}" });
    const r = await post("/hooks/pv/preview", { repo: "proj/api", pr: 42 });
    assert.equal(r.status, 200);
    assert.equal(r.body?.rendered, "proj/api #42");
    assert.equal(r.body?.wouldSend, true);
    assert.equal(sent.length, 0, "預覽不該送出");
  });

  it("POST /hooks/:name/preview：降噪命中時會說明原因", async () => {
    await post("/hooks", { name: "pv2", to: "工作群", platform: "line", template: "{{status}}", include: ["failed"] });
    const r = await post("/hooks/pv2/preview", { status: "passed" });
    assert.equal(r.body?.wouldSend, false);
    assert.ok(String(r.body?.reason).length > 0);
  });

  it("POST /hooks/:name/test：實際送出一則", async () => {
    sent.length = 0;
    await post("/hooks", { name: "ts", to: "工作群", platform: "line", template: "測試 {{x}}" });
    const r = await post("/hooks/ts/test", { x: "1" });
    assert.equal(r.status, 200);
    assert.equal(r.body?.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, "測試 1");
  });

  it("POST /hooks/:name/test：找不到 hook → 404", async () => {
    const r = await post("/hooks/nope/test", {});
    assert.equal(r.status, 404);
  });
});
