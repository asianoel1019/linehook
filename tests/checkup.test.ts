import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "../src/config.js";
import { registerService } from "../src/messaging/services.js";
import { createServer } from "../src/webhook/server.js";
import type { IMessagingService, SendInput } from "../src/messaging/types.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const fake: IMessagingService = {
  platform: "line",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (_inputs: SendInput[]) => {},
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
});

const auth = { Authorization: "Bearer tok-admin" };

describe("P1-1 設定健檢", () => {
  it("GET /health/check.json：七類檢查齊全＋欄位完整", async () => {
    const res = await fetch(`${base}/health/check.json`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      at: string;
      items: Array<{ id: string; ok: boolean; name: string; detail: string; fix: string }>;
    };
    assert.ok(body.at);
    const ids = body.items.map((i) => i.id);
    for (const want of ["platform:line", "conflicts", "scheduler", "storage", "alert", "outbound", "inbound"]) {
      assert.ok(ids.includes(want), `缺 ${want}（現有：${ids.join(",")}）`);
    }
    for (const item of body.items) {
      assert.equal(typeof item.ok, "boolean");
      assert.ok(item.name);
      assert.equal(typeof item.detail, "string");
      assert.equal(typeof item.fix, "string");
    }
    const plat = body.items.find((i) => i.id === "platform:line")!;
    assert.equal(plat.ok, true);
  });

  it("GET /dashboard：含健檢卡＋抓取掛鉤", async () => {
    const res = await fetch(`${base}/dashboard`, { headers: auth });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="checkup-card"'));
    assert.ok(html.includes("/health/check.json"));
    assert.ok(html.includes("checkup-reload"));
  });

  it("GET /dashboard：內嵌 JS 語法有效", async () => {
    const res = await fetch(`${base}/dashboard`, { headers: auth });
    const html = await res.text();
    const m = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, "應有內嵌 script");
    const tmp = join(tmpdir(), `dashboard-inline-${process.pid}.js`);
    writeFileSync(tmp, m[1], "utf8");
    try {
      const r = spawnSync(process.execPath, ["--check", tmp]);
      assert.equal(r.status, 0, String(r.stderr).slice(0, 300));
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("GET /skills/domains.json：技能網域報告（宣告 vs 實際）", async () => {
    const res = await fetch(`${base}/skills/domains.json`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      skills: Array<{ id: string; declared: string[]; actual: string[]; undeclared: string[]; ok: boolean }>;
      hosts: Array<{ host: string; skills: string[] }>;
      enforce: boolean;
    };
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.hosts));
    assert.equal(typeof body.enforce, "boolean");
    for (const row of body.skills) {
      assert.ok(Array.isArray(row.declared));
      assert.ok(Array.isArray(row.actual));
      assert.equal(row.ok, row.undeclared.length === 0);
    }
  });

  it("GET /traces.json：鏈路追蹤清單", async () => {
    const res = await fetch(`${base}/traces.json?limit=5`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { traces: unknown[] };
    assert.ok(Array.isArray(body.traces));
  });
});
