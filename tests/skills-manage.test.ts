import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { listSkills, reloadSkills } from "../src/skills/loader.js";
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

describe("技能安裝與移除", () => {
  it("uninstallSkill：外部技能刪除資料夾", async () => {
    const ext = join(config.skillsPath, "ext-demo");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "skill.json"), JSON.stringify({ name: "ext-demo" }));
    assert.equal(await uninstallSkill("ext-demo"), true);
    assert.ok(!existsSync(ext), "外部資料夾已刪除");
  });

  it("uninstallSkill：找不到技能回 false", async () => {
    assert.equal(await uninstallSkill("nope-not-here"), false);
  });

  it("所有技能都有分類（供技能列／安裝移除分組顯示）", async () => {
    await reloadSkills();
    const all = listSkills();
    assert.ok(all.length > 0, "應載入技能");
    for (const s of all) {
      const c = s.category;
      const v = typeof c === "string" ? c : c && (c.zh || c.en || c.ja);
      assert.ok(v, `技能 ${s.id} 缺少 category`);
    }
  });
});
