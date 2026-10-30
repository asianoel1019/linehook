import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { hotReloadActive, hotReloadCount, startHotReload, stopHotReload } from "../src/skills/hot-reload.js";

const savedSkillsPath = config.skillsPath;
const workDir = join(tmpdir(), `hotreload-${process.pid}`);
const skillDir = join(workDir, "skills");

before(() => {
  mkdirSync(join(skillDir, "demo"), { recursive: true });
  writeFileSync(
    join(skillDir, "demo", "index.js"),
    "export default { id: 'demo', name: 'Demo', defaultTrigger: 'demo', fields: [], run: async () => {} };",
    "utf8",
  );
  config.skillsPath = skillDir;
});

after(() => {
  stopHotReload();
  config.skillsPath = savedSkillsPath;
});

describe("P2 技能熱重載", () => {
  it("啟動後有在監看、可停止", () => {
    assert.equal(startHotReload(), true);
    assert.equal(hotReloadActive(), true);
    stopHotReload();
    assert.equal(hotReloadActive(), false);
  });

  it("改檔會觸發重載（計數增加）", async () => {
    stopHotReload();
    const before = hotReloadCount();
    assert.equal(startHotReload(), true);
    // 觸發一次檔案變更
    writeFileSync(join(skillDir, "demo", "index.js"), "export default { id: 'demo', name: 'Demo2', defaultTrigger: 'demo', fields: [], run: async () => {} };", "utf8");
    const start = Date.now();
    while (hotReloadCount() === before && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(hotReloadCount() > before, "應已觸發重載");
    stopHotReload();
  });

  it("stop 後不再重載", async () => {
    stopHotReload();
    const before = hotReloadCount();
    writeFileSync(join(skillDir, "demo", "index.js"), "export default { id: 'demo', name: 'Demo3', defaultTrigger: 'demo', fields: [], run: async () => {} };", "utf8");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(hotReloadCount(), before);
  });
});
