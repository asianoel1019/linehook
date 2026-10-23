import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { registerService } from "../src/messaging/services.js";
import { createServer } from "../src/webhook/server.js";
import type { IMessagingService, SendInput } from "../src/messaging/types.js";
import { installZip } from "../src/skills/install.js";
import { reloadSkills } from "../src/skills/loader.js";
import { setLibraryDir } from "../src/skills/library.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

const workRoot = join(tmpdir(), `skilllib-${process.pid}`);
const skillsDir = join(workRoot, "skills");
const libDir = join(workRoot, "library");
const savedSkillsPath = config.skillsPath;

const INDEX = `export default { id: "upg1", name: "Upg", defaultTrigger: "upg", fields: [], run: async () => {} };`;

async function makeZip(skillJson: Record<string, unknown>): Promise<Buffer> {
  const { zipSync } = await import("fflate");
  return Buffer.from(
    zipSync({
      "skill.json": Buffer.from(JSON.stringify(skillJson), "utf8"),
      "index.js": Buffer.from(INDEX, "utf8"),
    }),
  );
}

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
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  config.skillsPath = skillsDir;
  config.apiTokenEnabled = true;
  config.apiTokens = [{ name: "t", token: "tok-admin", scopes: ["admin"] }];
  registerService(fake);
  const app = createServer(fake);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  config.apiToken = savedApiToken;
  config.apiTokenEnabled = savedApiTokenEnabled;
  config.apiTokens = savedApiTokens;
  config.skillsPath = savedSkillsPath;
  setLibraryDir(null);
  await reloadSkills();
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

describe("P3 技能庫比對／升級／回滾", () => {
  it("庫沒建過：updates.json 回空不炸", async () => {
    setLibraryDir(join(workRoot, "no-such-lib"));
    const { status, body } = await get("/skills/updates.json");
    assert.equal(status, 200);
    assert.deepEqual(body?.updates, []);
    assert.equal((body?.library as Record<string, unknown>)?.built, false);
  });

  it("備料：庫放 upg1 v9.9.9＋api999 的 newapi，本地裝 upg1 v1.0.0", async () => {
    setLibraryDir(libDir);
    writeFileSync(
      join(libDir, "index.json"),
      JSON.stringify({
        generated: new Date().toISOString(),
        count: 2,
        skills: [
          { id: "upg1", name: "Upg", version: "9.9.9", api: 1 },
          { id: "newapi", name: "New", version: "1.0.0", api: 999 },
        ],
      }),
      "utf8",
    );
    writeFileSync(join(libDir, "upg1.zip"), await makeZip({ id: "upg1", version: "9.9.9", api: 1 }));
    writeFileSync(join(libDir, "newapi.zip"), await makeZip({ id: "newapi", version: "1.0.0", api: 999 }));
    const r = await installZip(await makeZip({ id: "upg1", version: "1.0.0", api: 1 }));
    assert.equal(r.version, "1.0.0");

    const { status, body } = await get("/skills/updates.json");
    assert.equal(status, 200);
    const updates = body?.updates as Array<Record<string, unknown>>;
    const upg = updates.find((u) => u.id === "upg1")!;
    assert.equal(upg.installedVersion, "1.0.0");
    assert.equal(upg.latestVersion, "9.9.9");
    assert.equal(upg.canUpgrade, true);
    assert.equal(upg.apiOk, true);
    // 沒裝的 newapi 不出現在 updates（只比對已安裝）
    assert.equal(updates.some((u) => u.id === "newapi"), false);
    assert.equal((body?.library as Record<string, unknown>)?.built, true);
  });

  it("POST /skills/upgrade：參數錯誤與未知技能", async () => {
    assert.equal((await post("/skills/upgrade", {})).status, 400);
    assert.equal((await post("/skills/upgrade", { id: "nope" })).status, 404);
  });

  it("POST /skills/upgrade：api 太新擋下", async () => {
    // 先裝一個舊版 newapi，再升庫版（api 999）→ 400
    await installZip(await makeZip({ id: "newapi", version: "0.1.0", api: 1 }));
    const { status, body } = await post("/skills/upgrade", { id: "newapi" });
    assert.equal(status, 400);
    assert.ok(String(body?.error).includes("api 999"));
  });

  it("POST /skills/upgrade：v1.0.0 → v9.9.9，備份舊版", async () => {
    const { status, body } = await post("/skills/upgrade", { id: "upg1" });
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    assert.equal(body?.version, "9.9.9");
    assert.equal(body?.previousVersion, "1.0.0");
    assert.equal(body?.backedUp, true);

    const inst = await get("/skills/installed.json");
    const row = (inst.body?.installed as Array<Record<string, unknown>>).find((s) => s.id === "upg1")!;
    assert.equal(row.version, "9.9.9");
    assert.equal(row.hasBackup, true);

    const upd = await get("/skills/updates.json");
    const upg = (upd.body?.updates as Array<Record<string, unknown>>).find((u) => u.id === "upg1")!;
    assert.equal(upg.canUpgrade, false);
  });

  it("POST /skills/rollback：回到 v1.0.0", async () => {
    const { status, body } = await post("/skills/rollback", { id: "upg1" });
    assert.equal(status, 200);
    assert.equal(body?.version, "1.0.0");
    const inst = await get("/skills/installed.json");
    const row = (inst.body?.installed as Array<Record<string, unknown>>).find((s) => s.id === "upg1")!;
    assert.equal(row.version, "1.0.0");
  });

  it("POST /skills/rollback：無備份 404、缺 id 400", async () => {
    assert.equal((await post("/skills/rollback", {})).status, 400);
    assert.equal((await post("/skills/rollback", { id: "never-installed" })).status, 404);
  });

  it("GET /skills：管理頁含升級／回滾掛鉤", async () => {
    const res = await fetch(`${base}/skills`, { headers: auth });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("/skills/upgrade"));
    assert.ok(html.includes("/skills/rollback"));
    assert.ok(html.includes("/skills/updates.json"));
  });
});
