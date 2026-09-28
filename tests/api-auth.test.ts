import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Express } from "express";
import { config } from "../src/config.js";
import { createServer } from "../src/webhook/server.js";

let base = "";
let server: Server;

const stubLine = {
  listTargets: () => [],
  getQueueStats: () => ({ pending: 0, running: false }),
  listScheduled: () => [],
};

const saved = {
  hmacSecret: config.hmacSecret,
  webhookToken: config.webhookToken,
  apiToken: config.apiToken,
  apiTokens: config.apiTokens,
};

before(async () => {
  config.hmacSecret = "";
  config.webhookToken = "";
  config.apiToken = "main-secret";
  config.apiTokens = [
    { name: "reader", token: "ro-secret", scopes: ["read"] },
    { name: "sender", token: "send-secret", scopes: ["send"] },
    { name: "boss", token: "admin-secret", scopes: ["admin"] },
    { name: "dead", token: "dead-secret", scopes: [] },
  ];
  const app: Express = createServer(stubLine as never);
  await new Promise<void>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve());
    server = s as unknown as Server;
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

after(async () => {
  config.hmacSecret = saved.hmacSecret;
  config.webhookToken = saved.webhookToken;
  config.apiToken = saved.apiToken;
  config.apiTokens = saved.apiTokens;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(path: string, init?: RequestInit) {
  return fetch(base + path, init);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("webhook Bearer scopes", () => {
  it("send token 可呼叫 webhook（body 錯誤仍回 400，代表驗證通過）", async () => {
    const res = await call("/webhook", {
      method: "POST",
      headers: { ...bearer("send-secret"), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
  });

  it("read-only token 呼叫 webhook 回 403", async () => {
    const res = await call("/webhook", {
      method: "POST",
      headers: { ...bearer("ro-secret"), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  it("無 scope 的 token 哪裡都去不了", async () => {
    const res = await call("/dashboard.json", { headers: bearer("dead-secret") });
    assert.equal(res.status, 401);
  });

  it("錯誤 token 回 403", async () => {
    const res = await call("/webhook", {
      method: "POST",
      headers: { ...bearer("nope"), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });
});

describe("read scope", () => {
  it("read token 可讀 dashboard.json", async () => {
    const res = await call("/dashboard.json", { headers: bearer("ro-secret") });
    assert.equal(res.status, 200);
  });

  it("send token 不可讀 dashboard.json", async () => {
    const res = await call("/dashboard.json", { headers: bearer("send-secret") });
    assert.equal(res.status, 401);
  });

  it("無憑證讀 .json 回 401，讀頁面導向登入", async () => {
    const json = await call("/dashboard.json");
    assert.equal(json.status, 401);
    const page = await call("/dashboard", { redirect: "manual" });
    assert.equal(page.status, 302);
  });
});

describe("admin scope", () => {
  it("admin token 可讀 settings.json", async () => {
    const res = await call("/settings.json", { headers: bearer("admin-secret") });
    assert.equal(res.status, 200);
  });

  it("read token 不可讀 settings.json", async () => {
    const res = await call("/settings.json", { headers: bearer("ro-secret") });
    assert.equal(res.status, 401);
  });

  it("用量統計有記錄且可查詢", async () => {
    const res = await call("/tokens/usage.json", { headers: bearer("admin-secret") });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { usage: Array<{ name: string; count: number }> };
    const names = data.usage.map((u) => u.name);
    assert.ok(names.includes("sender"));
    assert.ok(names.includes("reader"));
    assert.ok(names.includes("boss"));
    const sender = data.usage.find((u) => u.name === "sender")!;
    assert.ok(sender.count >= 1);
  });
});
