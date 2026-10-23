import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { registerService } from "../src/messaging/services.js";
import { createServer } from "../src/webhook/server.js";
import type { IMessagingService, SendInput } from "../src/messaging/types.js";
import { setSkillStatsPath, resetSkillStatsCache, recordSkillRun, flushSkillStats } from "../src/skill-stats.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

let scheduleCalls = 0;
const fake: IMessagingService = {
  platform: "line",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (_inputs: SendInput[]) => {},
  schedule: () => {
    scheduleCalls += 1;
    return {} as never;
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
  setSkillStatsPath(join(tmpdir(), `skill-stats-api-${process.pid}.json`));
  resetSkillStatsCache();
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
  setSkillStatsPath(null);
  resetSkillStatsCache();
});

const auth = { Authorization: "Bearer tok-admin" };

async function get(path: string) {
  const res = await fetch(base + path, { headers: auth });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("P2 觀察性：usage／health／dry-run", () => {
  it("GET /skills/usage.json：列格式", async () => {
    recordSkillRun("lunar", true);
    flushSkillStats();
    const { status, body } = await get("/skills/usage.json");
    assert.equal(status, 200);
    const rows = body?.skills as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rows));
    const lunar = rows.find((r) => r.id === "lunar") as Record<string, unknown>;
    assert.ok(lunar.runs7d as number >= 1);
    assert.equal(typeof lunar.failRate, "number");
    assert.ok("lastAt" in lunar && "totalRuns" in lunar);
  });

  it("GET /skills/health：附加 journal＋recentErrors（加法不破壞既有）", async () => {
    recordSkillRun("bus", false, "tdx 401");
    flushSkillStats();
    const { status, body } = await get("/skills/health");
    assert.equal(status, 200);
    assert.ok(body?.health && typeof body.health === "object");
    const journal = body?.journal as Record<string, Record<string, unknown>>;
    assert.ok(journal);
    assert.equal(journal.bus.consecFails, 1);
    assert.equal(journal.bus.lastError, "tdx 401");
    assert.ok(Array.isArray(body?.recentErrors));
  });

  it("POST /skills/dry-run：缺 id 400、未知 id 404", async () => {
    assert.equal((await post("/skills/dry-run", {})).status, 400);
    assert.equal((await post("/skills/dry-run", { id: "no-such-skill", text: "hi" })).status, 404);
  });

  it("POST /skills/dry-run：lunar 純運算有回覆（決定性）", async () => {
    const { status, body } = await post("/skills/dry-run", { id: "lunar", text: "國曆 2026-09-28" });
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    const replies = body?.replies as string[];
    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes("農曆"));
    assert.deepEqual(body?.media, []);
  });

  it("POST /skills/dry-run：remind 排程被攔截（沙盒不留痕）", async () => {
    scheduleCalls = 0;
    const { status, body } = await post("/skills/dry-run", { id: "remind", text: "30分鐘後 喝水" });
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    const scheduled = body?.scheduled as string[];
    assert.ok(scheduled.length >= 1, "單次提醒應產生一筆排程（被攔截）");
    assert.equal(scheduleCalls, 0);
    const jobs = await get("/schedules.json");
    assert.deepEqual((jobs.body?.jobs as unknown[]).length, 0);
  });

  it("GET /skills：頁面含排序＋試跑掛鉤", async () => {
    const res = await fetch(`${base}/skills`, { headers: auth });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="skill-sort"'));
    assert.ok(html.includes("/skills/dry-run"));
    assert.ok(html.includes("/skills/usage.json"));
  });
});
