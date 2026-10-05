import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { degradedCapabilities, PLATFORM_CAPABILITIES } from "../src/messaging/capabilities.js";
import { validateSkillConfig } from "../src/skills/validate.js";
import { assertPublicUrl, BlockedHostError } from "../src/net.js";
import { sanitizeReadmeHtml } from "../src/webhook/server.js";

describe("degradedCapabilities", () => {
  it("LINE 全原生", () => {
    assert.deepEqual(degradedCapabilities("line"), []);
  });

  it("Telegram 有 sticker/flex 降級", () => {
    const notes = degradedCapabilities("telegram");
    assert.ok(notes.some((n) => n.startsWith("sticker")));
    assert.ok(notes.some((n) => n.startsWith("flex")));
  });

  it("Teams flex 為原生（Adaptive Card），location 降級", () => {
    assert.equal(PLATFORM_CAPABILITIES.teams.flex.level, "native");
    const notes = degradedCapabilities("teams");
    assert.ok(notes.some((n) => n.startsWith("location")));
    assert.ok(!notes.some((n) => n.startsWith("flex")));
  });

  it("未知平台回報", () => {
    assert.deepEqual(degradedCapabilities("nope"), ["未知平台：nope"]);
  });
});

describe("validateSkillConfig", () => {
  const def = {
    id: "demo",
    name: "示範",
    defaultTrigger: "demo",
    fields: [
      { key: "token", label: "Token", required: true },
      { key: "count", label: "次數", min: 1, max: 10 },
      { key: "mode", label: "模式", type: "select" as const, options: [{ value: "a", label: "A" }] },
      { key: "code", label: "代碼", pattern: "^[A-Z]{3}$" },
    ],
  };

  it("通過時回空陣列", () => {
    assert.deepEqual(validateSkillConfig(def, { token: "x", count: "5", mode: "a", code: "ABC" }), []);
  });

  it("指出缺必填、數字範圍、選項、格式", () => {
    const errors = validateSkillConfig(def, { token: "", count: "99", mode: "z", code: "ab" });
    assert.equal(errors.length, 4);
    assert.ok(errors.every((e) => e.includes("示範")));
  });

  it("未啟用技能不驗證（呼叫端責任），空值跳過選填", () => {
    assert.deepEqual(validateSkillConfig(def, {}), ["「示範」缺少必填欄位「Token」"]);
  });
});

describe("assertPublicUrl", () => {
  it("擋掉 loopback 與內網字面 IP", async () => {
    await assert.rejects(() => assertPublicUrl("http://127.0.0.1:8090/x"), BlockedHostError);
    await assert.rejects(() => assertPublicUrl("http://10.1.2.3/"), BlockedHostError);
    await assert.rejects(() => assertPublicUrl("http://169.254.169.254/"), BlockedHostError);
    await assert.rejects(() => assertPublicUrl("http://localhost:11434/"), BlockedHostError);
  });

  it("擋掉非 http(s)", async () => {
    await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), BlockedHostError);
    await assert.rejects(() => assertPublicUrl("gopher://x/"), BlockedHostError);
  });

  it("公開 IP 字面放行（不需 DNS）", async () => {
    await assertPublicUrl("https://8.8.8.8/");
  });
});

describe("sanitizeReadmeHtml", () => {
  it("移除 script 與事件屬性、javascript: 連結", () => {
    const out = sanitizeReadmeHtml(
      `<p>hi</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">go</a><svg onload="alert(4)">`,
    );
    assert.ok(!out.includes("<script"));
    assert.ok(!out.includes("onerror"));
    assert.ok(!out.includes("onload"));
    assert.ok(!out.includes("javascript:"));
    assert.ok(out.includes("<p>hi</p>"));
  });

  it("保留正常內容與 data:image", () => {
    const out = sanitizeReadmeHtml(`<a href="https://example.com">x</a><img src="data:image/png;base64,AAA">`);
    assert.ok(out.includes("https://example.com"));
    assert.ok(out.includes("data:image/png;base64,AAA"));
  });
});
