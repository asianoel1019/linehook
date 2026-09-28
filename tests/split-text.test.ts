import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitText } from "../src/line/client.js";

describe("splitText", () => {
  it("短文字不切割", () => {
    assert.deepEqual(splitText("hello", 4000), ["hello"]);
  });

  it("limit <= 0 不切割", () => {
    assert.deepEqual(splitText("hello", 0), ["hello"]);
    assert.deepEqual(splitText("hello", -1), ["hello"]);
  });

  it("優先切在換行", () => {
    const parts = splitText("a".repeat(3995) + "\n" + "b".repeat(10), 4000);
    assert.equal(parts.length, 2);
    assert.equal(parts[0], "a".repeat(3995));
    assert.equal(parts[1], "b".repeat(10));
  });

  it("無換行無空白時硬切且可還原", () => {
    const s = "x".repeat(9000);
    const parts = splitText(s, 4000);
    assert.equal(parts.length, 3);
    assert.equal(parts.join(""), s);
  });

  it("不從 emoji surrogate pair 中間切開", () => {
    const s = "A".repeat(3999) + "😀" + "B".repeat(10);
    const parts = splitText(s, 4000);
    assert.ok(parts.length >= 2);
    assert.equal(parts.join(""), s);
    for (const p of parts) {
      assert.ok(!/�/.test(p));
      const last = p.charCodeAt(p.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), "段尾不可是 high surrogate");
    }
  });
});
