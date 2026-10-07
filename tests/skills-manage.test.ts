import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { getSkill, hideSkill, readHiddenSkills, reloadSkills, restoreSkill } from "../src/skills/loader.js";
import { uninstallSkill } from "../src/skills/install.js";

let dir = "";
const savedSkillsPath = config.skillsPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-manage-"));
  config.skillsPath = join(dir, "skills");
});

afterEach(() => {
  config.skillsPath = savedSkillsPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("技能隱藏與移除", () => {
  it("hideSkill / restoreSkill / readHiddenSkills 往返", () => {
    assert.deepEqual(readHiddenSkills(), []);
    assert.equal(hideSkill("demo"), true);
    assert.equal(hideSkill("demo"), false, "重複隱藏回 false");
    assert.deepEqual(readHiddenSkills(), ["demo"]);
    assert.equal(restoreSkill("demo"), true);
    assert.equal(restoreSkill("demo"), false, "本來沒隱藏回 false");
    assert.deepEqual(readHiddenSkills(), []);
  });

  it("uninstallSkill：外部技能刪除資料夾（不進隱藏清單）", async () => {
    const ext = join(config.skillsPath, "ext-demo");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "skill.json"), JSON.stringify({ name: "ext-demo" }));
    assert.equal(await uninstallSkill("ext-demo"), true);
    assert.ok(!existsSync(ext), "外部資料夾已刪除");
    assert.deepEqual(readHiddenSkills(), []);
  });

  it("uninstallSkill：內建技能改為隱藏、不再載入；restore 後恢復", async () => {
    assert.equal(await uninstallSkill("unit"), true);
    assert.deepEqual(readHiddenSkills(), ["unit"]);
    assert.equal(getSkill("unit"), undefined, "隱藏後不再載入");
    assert.equal(restoreSkill("unit"), true);
    await reloadSkills();
    assert.ok(getSkill("unit"), "恢復後重新載入");
  });

  it("uninstallSkill：找不到技能回 false", async () => {
    assert.equal(await uninstallSkill("nope-not-here"), false);
  });
});
