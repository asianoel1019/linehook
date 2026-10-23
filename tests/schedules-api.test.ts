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
import { setSchedulesMetaPath } from "../src/schedules-meta.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const JOBS = [
  {
    id: "job-skill-1",
    runAt: new Date(Date.now() + 3600_000).toISOString(),
    to: ["c1"],
    summary: "技能任務：remind/daily",
    repeat: "0 8 * * *",
    recurring: true,
    skillTask: { skillId: "remind", task: "daily", chat: "c1", args: { text: "吃藥" } },
  },
  {
    id: "job-plain-1",
    runAt: new Date(Date.now() + 7200_000).toISOString(),
    to: ["c2"],
    summary: "text:hello",
    recurring: false,
  },
];

const fake: IMessagingService = {
  platform: "line",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (_inputs: SendInput[]) => {},
  schedule: () => ({}) as never,
  updateScheduled: () => null,
  listScheduled: () => JOBS as never,
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
  setSchedulesMetaPath(join(tmpdir(), `sched-meta-api-${process.pid}.json`));
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
  setSchedulesMetaPath(null);
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

describe("/schedules 一覽與控制", () => {
  it("GET /schedules.json：跨平台聚合＋技能名＋靜音/lastRun 欄位", async () => {
    const { status, body } = await get("/schedules.json");
    assert.equal(status, 200);
    const jobs = body?.jobs as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 2);
    const skill = jobs.find((j) => j.id === "job-skill-1") as Record<string, unknown>;
    assert.equal(skill.platform, "line");
    assert.equal((skill.skillTask as Record<string, unknown>)?.skillName, "提醒 / 倒數");
    assert.equal(skill.muted, false);
    assert.equal(skill.lastRun, null);
    assert.equal(skill.freq, "每天 08:00");
  });

  it("GET /schedules：已併入技能頁籤，轉址到 /skills#schedules", async () => {
    const res = await fetch(`${base}/schedules`, { headers: auth, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/skills#schedules");
  });

  it("GET /skills：含排程頁籤（body＋script 移植）", async () => {
    const res = await fetch(`${base}/skills`, { headers: auth });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('data-tab="schedules"'));
    assert.ok(html.includes('id="tab-schedules"'));
    assert.ok(html.includes("schLoad"));
    assert.ok(html.includes("/schedules.json"));
  });

  it("POST /schedules/mute：開關靜音", async () => {
    let r = await post("/schedules/mute", { id: "job-skill-1", muted: true });
    assert.equal(r.status, 200);
    assert.equal(r.body?.ok, true);
    let g = await get("/schedules.json");
    const jobs = g.body?.jobs as Array<Record<string, unknown>>;
    assert.equal(jobs.find((j) => j.id === "job-skill-1")?.muted, true);
    r = await post("/schedules/mute", { id: "job-skill-1", muted: false });
    assert.equal(r.status, 200);
    g = await get("/schedules.json");
    assert.equal((g.body?.jobs as Array<Record<string, unknown>>).find((j) => j.id === "job-skill-1")?.muted, false);
  });

  it("POST /schedules/mute：缺 id 回 400", async () => {
    const r = await post("/schedules/mute", {});
    assert.equal(r.status, 400);
  });

  it("POST /schedules/quiet：合法儲存、非法 400", async () => {
    let r = await post("/schedules/quiet", { enabled: true, from: "xx", to: "07:00" });
    assert.equal(r.status, 400);
    r = await post("/schedules/quiet", { enabled: true, from: "23:00", to: "07:00" });
    assert.equal(r.status, 200);
    const g = await get("/schedules.json");
    assert.deepEqual(g.body?.quiet, { enabled: true, from: "23:00", to: "07:00" });
    r = await post("/schedules/quiet", { enabled: false, from: "23:00", to: "07:00" });
    assert.equal(r.status, 200);
  });

  it("POST /schedules/mute-all：總開關", async () => {
    const r1 = await post("/schedules/mute-all", { muted: true });
    assert.equal(r1.status, 200);
    assert.equal(r1.body?.globalMute, true);
    const g = await get("/schedules.json");
    assert.equal(g.body?.globalMute, true);
    const r2 = await post("/schedules/mute-all", { muted: false });
    assert.equal(r2.status, 200);
    assert.equal((await get("/schedules.json")).body?.globalMute, false);
  });

  it("未授權擋下（401）", async () => {
    const res = await fetch(`${base}/schedules.json`);
    assert.equal(res.status, 401);
  });
});
