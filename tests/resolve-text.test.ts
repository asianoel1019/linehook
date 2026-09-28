import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveText } from "../src/skills/types.js";

describe("resolveText", () => {
  it("字串原樣回傳", () => {
    assert.equal(resolveText("hello", "en"), "hello");
  });

  it("undefined 回空字串", () => {
    assert.equal(resolveText(undefined, "zh"), "");
  });

  it("多語物件取對應語言", () => {
    assert.equal(resolveText({ zh: "中文", en: "English", ja: "日本語" }, "en"), "English");
    assert.equal(resolveText({ zh: "中文", en: "English", ja: "日本語" }, "ja"), "日本語");
  });

  it("缺漏語言回退 zh", () => {
    assert.equal(resolveText({ zh: "中文" }, "en"), "中文");
    assert.equal(resolveText({ zh: "中文", en: "English" }, "ja"), "中文");
  });
});
