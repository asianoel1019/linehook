import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { config } from "../src/config.js";
import {
  backupSkill,
  compareVersions,
  hasSkillBackup,
  installZip,
  listInstalled,
  rollbackSkill,
  uninstallSkill,
} from "../src/skills/install.js";
import { reloadSkills } from "../src/skills/loader.js";

const savedSkillsPath = config.skillsPath;
const workRoot = join(tmpdir(), `skillver-${process.pid}`);
const skillsDir = join(workRoot, "skills");

before(() => {
  mkdirSync(skillsDir, { recursive: true });
  config.skillsPath = skillsDir;
});

after(async () => {
  config.skillsPath = savedSkillsPath;
  await reloadSkills();
});

async function makeZip(skillJson: Record<string, unknown>, indexJs: string | null): Promise<Buffer> {
  const { zipSync } = await import("fflate");
  const files: Record<string, Uint8Array> = {
    "skill.json": Buffer.from(JSON.stringify(skillJson), "utf8"),
  };
  if (indexJs !== null) files["index.js"] = Buffer.from(indexJs, "utf8");
  return Buffer.from(zipSync(files));
}

const INDEX_V1 = `export default { id: "ver1", name: "Ver", defaultTrigger: "ver", fields: [], run: async () => {} };`;

function installedVersion(id: string): string {
  return listInstalled().find((s) => s.id === id)?.version ?? "<missing>";
}

function backupVersion(id: string): string {
  try {
    const m = JSON.parse(readFileSync(join(workRoot, "skill-backups", `${id}.bak`, "skill.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof m.version === "string" ? m.version : "";
  } catch {
    return "<missing>";
  }
}

describe("P3 技能版本：備份／回滾", () => {
  it("compareVersions：語義比較", () => {
    assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("2.0", "2.0.0"), 0);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("", "1.0.0"), -1);
  });

  it("首次安裝：無備份、記版本", async () => {
    const r = await installZip(await makeZip({ id: "ver1", version: "1.0.0", api: 1 }, INDEX_V1));
    assert.equal(r.id, "ver1");
    assert.equal(r.version, "1.0.0");
    assert.equal(r.previousVersion, "");
    assert.equal(r.backedUp, false);
    assert.equal(installedVersion("ver1"), "1.0.0");
    assert.equal(hasSkillBackup("ver1"), false);
  });

  it("覆蓋安裝：備份舊版、記 previousVersion", async () => {
    const r = await installZip(await makeZip({ id: "ver1", version: "2.0.0", api: 1 }, INDEX_V1));
    assert.equal(r.backedUp, true);
    assert.equal(r.previousVersion, "1.0.0");
    assert.equal(r.version, "2.0.0");
    assert.equal(installedVersion("ver1"), "2.0.0");
    assert.equal(hasSkillBackup("ver1"), true);
    assert.equal(backupVersion("ver1"), "1.0.0");
  });

  it("回滾：與備份交換、可反覆橫跳", async () => {
    const r1 = await rollbackSkill("ver1");
    assert.equal(r1?.version, "1.0.0");
    assert.equal(installedVersion("ver1"), "1.0.0");
    assert.equal(backupVersion("ver1"), "2.0.0");
    const r2 = await rollbackSkill("ver1");
    assert.equal(r2?.version, "2.0.0");
    assert.equal(installedVersion("ver1"), "2.0.0");
  });

  it("壞包覆蓋（缺 index.js）：舊版自動還原、不人間蒸發", async () => {
    await assert.rejects(
      installZip(await makeZip({ id: "ver1", version: "9.9.9", api: 1 }, null)),
      /缺少 index/,
    );
    assert.equal(installedVersion("ver1"), "2.0.0");
  });

  it("api 太新：安裝前就擋下、舊版原封不動", async () => {
    await assert.rejects(
      installZip(await makeZip({ id: "vernew", version: "1.0.0", api: 999 }, INDEX_V1)),
      /api 999/,
    );
    assert.equal(existsSync(join(skillsDir, "vernew")), false);
    assert.equal(hasSkillBackup("vernew"), false);
  });

  it("無備份／未知 id：回滾回 null、備份回 false", async () => {
    assert.equal(await rollbackSkill("never-installed"), null);
    assert.equal(await rollbackSkill(""), null);
    assert.equal(backupSkill("never-installed"), false);
    assert.equal(hasSkillBackup("never-installed"), false);
  });

  it("移除：連備份一起清", async () => {
    // 前一輪壞包還原把備份消耗掉了，先升一版重建備份
    await installZip(await makeZip({ id: "ver1", version: "3.0.0", api: 1 }, INDEX_V1));
    assert.equal(hasSkillBackup("ver1"), true);
    assert.equal(await uninstallSkill("ver1"), true);
    assert.equal(existsSync(join(skillsDir, "ver1")), false);
    assert.equal(hasSkillBackup("ver1"), false);
    assert.equal(await uninstallSkill("ver1"), false);
  });
});
