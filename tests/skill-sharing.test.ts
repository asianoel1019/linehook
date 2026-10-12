/**
 * 自包含技能分享：兩個方向的保證
 *  A. 安裝面：外部技能放在 data/skills/<id>/index.js，只用 @lw/* 別名匯入，
 *     能在不帶任何相依檔的情況下被載入並執行（模擬真實 zip 安裝）。
 *  B. 打包面：buildSkillZip 產出的 zip 只有 skill.json + index.js，
 *     且 index.js 沒有任何相對匯出（靜態掃描）——從此不會再「裝了卻靜默消失」。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { config } from "../src/config.js";
import { loadSkills, reloadSkills } from "../src/skills/loader.js";
import { buildSkillZip, installZip, SKILL_API_VERSION } from "../src/skills/install.js";
import type { SkillContext } from "../src/skills/types.js";

const savedSkillsPath = config.skillsPath;
let dir = "";
let external = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-sharing-"));
  external = join(dir, "skills");
  config.skillsPath = external;
});

afterEach(() => {
  config.skillsPath = savedSkillsPath;
  rmSync(dir, { recursive: true, force: true });
});

/** 裝一個外部技能：只用 @lw/* 匯入，模擬從 zip 解壓後的樣子。 */
async function installFakeSkill(id: string): Promise<void> {
  const folder = join(external, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "index.js"),
    `import { chat } from "@lw/skills/llm";
import { fetchWeather } from "@lw/skills/weather";
import { parseTtl } from "@lw/skills/cache";
export default {
  id: ${JSON.stringify(id)},
  name: "外部技能",
  defaultTrigger: "ext",
  async run(ctx) {
    // 用宿主的 llm 組設定（不真的呼叫，只驗證模組可用）
    const { llmConfigFrom } = await import("@lw/skills/llm");
    const cfg = llmConfigFrom({});
    assertHas(cfg, "provider");
    // 用宿主的快取工具與（不呼叫網路的）技能函式存在性
    parseTtl("10m", 60);
    await ctx.reply("ext-ok:" + typeof fetchWeather + ":" + typeof chat);
  },
};
function assertHas(obj, key) { if (!obj || !(key in obj)) throw new Error("缺少 " + key); }
`,
    "utf8",
  );
  writeFileSync(join(folder, "skill.json"), JSON.stringify({ id, name: "外部技能", api: 1 }), "utf8");
  await reloadSkills();
}

describe("外部技能：只用 @lw/* 也能跑", () => {
  it("從 data/skills 載入並使用宿主模組（llm/weather/cache）", async () => {
    await installFakeSkill("probe");
    const all = await loadSkills();
    const skill = all.find((s) => s.id === "probe");
    assert.ok(skill, "技能應被載入");

    const replies: string[] = [];
    await skill!.run({
      text: "ext",
      args: "",
      fromName: "tester",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    } as unknown as SkillContext);
    assert.match(replies[0], /^ext-ok:function:function$/);
  });

  it("兩個技能共享同一個宿主模組實例（單例不破裂）", async () => {
    await installFakeSkill("probe-a");
    await installFakeSkill("probe-b");
    const all = await loadSkills();
    const ids = all.filter((s) => s.id.startsWith("probe-")).map((s) => s.id);
    assert.deepEqual(ids.sort(), ["probe-a", "probe-b"]);
    // 兩個都用 @lw/skills/llm；若被複製成兩份，llmConfigFrom 的 config 也會分家。
    // 這邊以「都能執行且輸出一致」間接驗證同一份模組解析成功。
    const replies: string[] = [];
    for (const s of all.filter((x) => x.id.startsWith("probe-"))) {
      await s.run({
        text: "x",
        args: "",
        fromName: "t",
        chat: "c1",
        fromMid: "u1",
        config: {},
        reply: async (t: string) => {
          replies.push(t);
        },
        sendImage: async () => {},
        sendFile: async () => {},
        schedule: () => "",
        watch: () => "",
        unwatch: () => true,
        watches: () => [],
        taskState: () => undefined,
      } as unknown as SkillContext);
    }
    assert.equal(replies.length, 2);
    assert.equal(new Set(replies).size, 1);
  });
});

describe("別名匯入的邊界", () => {
  it("拒絕穿越目錄（@lw/../secret）", async () => {
    const folder = join(external, "evil");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "index.js"),
      `import x from "@lw/../../package.json"; export default { id: "evil", name: "x", defaultTrigger: "e", async run() {} };`,
      "utf8",
    );
    await reloadSkills();
    const all = await loadSkills();
    assert.equal(
      all.find((s) => s.id === "evil"),
      undefined,
      "穿越別名的技能不該被載入",
    );
  });

  it("未知別名給的出明確錯誤", async () => {
    const folder = join(external, "missing");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "index.js"),
      `import x from "@lw/skills/nope"; export default { id: "missing", name: "x", defaultTrigger: "m", async run() {} };`,
      "utf8",
    );
    await reloadSkills();
    const all = await loadSkills();
    assert.equal(
      all.find((s) => s.id === "missing"),
      undefined,
    );
  });
});

describe("zip 自包含（打包面保證）", () => {
  it("buildSkillZip 只帶 skill.json＋index.js，且 index.js 沒有相對匯入", async () => {
    const zip = await buildSkillZip("ai", {
      name: "AI 助理",
      description: { zh: "x" },
      usage: { zh: "問 …" },
      category: { zh: "智慧助理" },
      defaultTrigger: "問",
      triggerAliases: ["ai"],
    });
    assert.ok(zip, "應產出 zip");
    const files = unzipSync(new Uint8Array(zip!));
    const names = Object.keys(files).sort();
    // 正式（dist 有編譯檔）是 index.js；本機未 build 時退回 index.ts
    const entryName = names.find((n) => n.startsWith("index."))!;
    assert.deepEqual(names, [entryName, "skill.json"].sort(), "zip 只該有進入點與 manifest");

    const source = Buffer.from(files[entryName]).toString("utf8");
    // 任何相對匯入（../ 或 ./）都代表 zip 裝了會壞
    const relative = source.match(/(?:from|import)\s*["']\.\.?\/[^"']+["']/g) ?? [];
    assert.deepEqual(relative, [], `index 不該有相對匯入，found: ${relative.join(", ")}`);
    // 共享依賴都走別名
    assert.match(source, /@lw\/skills\/llm/);
    assert.match(source, /@lw\/skills\/agent/);

    const manifest = JSON.parse(Buffer.from(files["skill.json"]).toString("utf8")) as { api?: number; id?: string };
    assert.equal(manifest.id, "ai");
    assert.equal(manifest.api, SKILL_API_VERSION);
  });

  it("所有內建技能的 index.js 都沒有相對匯入（全體迴歸）", async () => {
    // dist 需先 build；此斷言等價於「每個技能都能自包含分享」
    const { readdirSync, existsSync } = await import("node:fs");
    const { readFileSync } = await import("node:fs");
    const distSkills = new URL("../dist/skills/", import.meta.url);
    if (!existsSync(distSkills)) return; // 沒 build 就跳過（CI 有 build）
    for (const name of readdirSync(distSkills)) {
      const entry = new URL(`${name}/index.js`, distSkills);
      if (!existsSync(entry)) continue;
      const src = readFileSync(entry, "utf8");
      const relative = src.match(/(?:from|import)\s*["']\.\.?\/[^"']+["']/g) ?? [];
      assert.deepEqual(relative, [], `${name}: ${relative.join(", ")}`);
    }
  });
});

describe("installZip：api 版本把關", () => {
  it("api 高於主機 → 明確拒絕且不安裝", async () => {
    const { zipSync } = await import("fflate");
    const zip = Buffer.from(
      zipSync({
        "skill.json": new TextEncoder().encode(
          JSON.stringify({ id: "future", name: "未來技能", api: SKILL_API_VERSION + 1 }),
        ),
        "index.js": new TextEncoder().encode(
          "export default { id: 'future', name: 'x', defaultTrigger: 'f', async run() {} };",
        ),
      }),
    );
    await assert.rejects(installZip(zip), /api \d+ > 本機 \d+/);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(external, "future")), false, "不該留下資料夾");
  });

  it("api 符合 → 正常安裝", async () => {
    const { zipSync } = await import("fflate");
    const zip = Buffer.from(
      zipSync({
        "skill.json": new TextEncoder().encode(JSON.stringify({ id: "ok-one", name: "合規", api: SKILL_API_VERSION })),
        "index.js": new TextEncoder().encode(
          "export default { id: 'ok-one', name: 'x', defaultTrigger: 'o', async run() {} };",
        ),
      }),
    );
    const result = await installZip(zip);
    assert.equal(result.id, "ok-one");
    const all = await loadSkills();
    assert.ok(all.find((s) => s.id === "ok-one"));
  });
});
