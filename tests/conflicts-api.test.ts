import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
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
const savedSkills = [...config.skills];
const savedApiTokenEnabled = config.apiTokenEnabled;
const savedApiTokens = [...config.apiTokens];

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  trigger: "",
  triggerEnabled: true,
  allowedUsers: [],
  config: {},
  ...extra,
});

before(async () => {
  config.apiTokenEnabled = true;
  config.apiTokens = [{ name: "t", token: "tok-admin", scopes: ["admin"] }];
  registerService(fake);
  const app = createServer(fake);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  config.skills = [...savedSkills];
  config.apiTokenEnabled = savedApiTokenEnabled;
  config.apiTokens = savedApiTokens;
});

const auth = { Authorization: "Bearer tok-admin" };

describe("觸發詞衝突比照 API", () => {
  it("未授權 401", async () => {
    const res = await fetch(`${base}/skills/conflicts.json`);
    assert.equal(res.status, 401);
  });

  it("摘要 exact：列出雙方出處＋預測 summarize 勝", async () => {
    config.skills = [entry("summarize"), entry("rss")];
    const res = await fetch(`${base}/skills/conflicts.json`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      conflicts: Array<{
        word: string;
        kind: string;
        owners: Array<{ id: string; name: string; primary: boolean; claim: string }>;
        winner: string | null;
      }>;
    };
    const c = body.conflicts.find((x) => x.word === "摘要" && x.kind === "exact");
    assert.ok(c, "應有「摘要」exact 衝突");
    const byId = Object.fromEntries(c!.owners.map((o) => [o.id, o]));
    assert.equal(byId.summarize.primary, true);
    assert.equal(byId.summarize.claim, "摘要");
    assert.equal(byId.rss.primary, false);
    assert.equal(byId.rss.claim, "摘要");
    assert.equal(c!.winner, "summarize");
  });

  it("關掉 rss 的摘要別名後：衝突消失", async () => {
    config.skills = [entry("summarize"), entry("rss", { disabledAliases: ["摘要"] })];
    const res = await fetch(`${base}/skills/conflicts.json`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conflicts: Array<{ word: string }> };
    assert.ok(!body.conflicts.some((x) => x.word === "摘要"), "關掉後不該再有「摘要」衝突");
  });
});
