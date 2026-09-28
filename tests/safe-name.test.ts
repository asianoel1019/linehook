import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeName } from "../src/skills/install.js";

describe("safeName", () => {
  it("正常 id 不變", () => {
    assert.equal(safeName("weather"), "weather");
    assert.equal(safeName("kfc-coupon"), "kfc-coupon");
  });

  it('"..." 變空字串（uninstall 守衛依賴此行為）', () => {
    assert.equal(safeName("..."), "");
    assert.equal(safeName("."), "");
  });

  it("路徑穿越字元被中和", () => {
    const out = safeName("../../etc/passwd");
    assert.ok(!out.includes("/"));
    assert.ok(!out.includes("\\"));
  });

  it("空白與特殊字元轉底線", () => {
    assert.equal(safeName("my skill!"), "my_skill_");
  });
});
