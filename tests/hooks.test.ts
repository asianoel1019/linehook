import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  deleteHook,
  getHook,
  listHooks,
  matchesHookFilters,
  renderTemplate,
  setHooksPath,
  upsertHook,
} from "../src/hooks.js";

const workDir = join(tmpdir(), `hooks-${process.pid}`);

before(() => {
  setHooksPath(join(workDir, "hooks.json"));
});

after(() => {
  setHooksPath(null);
});

describe("hooks 設定", () => {
  it("新增／更新／刪除", () => {
    const r = upsertHook({ name: "ci-failed", to: "工作群", platform: "line", template: "{{repo}} #{{pr}} 失敗" });
    assert.equal(r.ok, true);
    assert.equal(listHooks().length, 1);
    assert.equal(getHook("ci-failed")?.to, "工作群");

    const r2 = upsertHook({ name: "ci-failed", to: "新對話" });
    assert.equal(r2.ok, true);
    assert.equal(listHooks().length, 1, "同名應覆蓋而非新增");
    assert.equal(getHook("ci-failed")?.to, "新對話");
    assert.equal(getHook("CI-FAILED")?.to, "新對話", "名稱大小寫不拘");

    assert.equal(deleteHook("ci-failed"), true);
    assert.equal(deleteHook("ci-failed"), false);
    assert.equal(listHooks().length, 0);
  });

  it("不合法設定被擋下（缺 to／名稱含空格）", () => {
    assert.equal(upsertHook({ name: "bad name", to: "x" }).ok, false);
    assert.equal(upsertHook({ name: "no-target" }).ok, false);
    assert.equal(upsertHook({ name: "", to: "x" }).ok, false);
  });

  it("存檔後可重讀", () => {
    upsertHook({ name: "h1", to: "t", platform: "telegram", include: ["failed"], secret: "s3cr3t" });
    assert.ok(existsSync(join(workDir, "hooks.json")));
    const hook = getHook("h1");
    assert.equal(hook?.platform, "telegram");
    assert.deepEqual(hook?.include, ["failed"]);
    assert.equal(hook?.secret, "s3cr3t");
    deleteHook("h1");
  });
});

describe("範本渲染", () => {
  it("取值／巢狀取值／缺值留空", () => {
    const data = { repo: "proj/api", pr: 4213, obj: { name: "Neal" } };
    assert.equal(renderTemplate("{{repo}} #{{pr}}", data), "proj/api #4213");
    assert.equal(renderTemplate("{{obj.name}}", data), "Neal");
    assert.equal(renderTemplate("[{{missing}}]", data), "[]");
    assert.equal(renderTemplate("", data), "");
  });

  it("濾鏡：upper／lower／truncate／default", () => {
    const data = { msg: "Build Failed", n: 123456 };
    assert.equal(renderTemplate("{{msg | upper}}", data), "BUILD FAILED");
    assert.equal(renderTemplate("{{msg | lower}}", data), "build failed");
    assert.equal(renderTemplate("{{msg | truncate:5}}", data), "Build");
    assert.equal(renderTemplate("{{missing | default:無}}", data), "無");
  });

  it("數字與物件會被字串化", () => {
    assert.equal(renderTemplate("{{n}}", { n: 42 }), "42");
    assert.equal(renderTemplate("{{o}}", { o: { a: 1 } }), '{"a":1}');
  });
});

describe("降噪條件", () => {
  it("include：命中才送", () => {
    const hook = { name: "h", to: "t", platform: "line", include: ["failed"] };
    assert.equal(matchesHookFilters(hook, { status: "failed" }).pass, true);
    assert.equal(matchesHookFilters(hook, { status: "passed" }).pass, false);
  });

  it("exclude：命中就不送（優先於 include）", () => {
    const hook = { name: "h", to: "t", platform: "line", include: ["failed"], exclude: ["draft"] };
    assert.equal(matchesHookFilters(hook, { status: "failed", branch: "draft" }).pass, false);
  });

  it("沒有條件就都送", () => {
    const hook = { name: "h", to: "t", platform: "line" };
    assert.equal(matchesHookFilters(hook, { anything: 1 }).pass, true);
  });

  it("比對會涵蓋 key 與 value", () => {
    const hook = { name: "h", to: "t", platform: "line", include: ["production"] };
    assert.equal(matchesHookFilters(hook, { env: "production" }).pass, true);
  });
});
