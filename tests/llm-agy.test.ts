import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgyResult } from "../src/skills/llm.js";

function mustText(r: unknown): { text: string; usage?: { inputTokens?: number; outputTokens?: number } } {
  if (!r || typeof r !== "object" || !("text" in r)) throw new Error(`預期成功卻拿到：${JSON.stringify(r)}`);
  return r as { text: string; usage?: { inputTokens?: number; outputTokens?: number } };
}

function mustError(r: unknown): string {
  if (!r || typeof r !== "object" || !("error" in r)) throw new Error(`預期失敗卻拿到：${JSON.stringify(r)}`);
  return (r as { error: string }).error;
}

describe("parseAgyResult", () => {
  it("SUCCESS envelope 回傳文字與用量", () => {
    const r = mustText(parseAgyResult(
      JSON.stringify({ status: "SUCCESS", response: "  hi  ", usage: { input_tokens: 10, output_tokens: 5 } }),
      "",
      0,
    ));
    assert.equal(r.text, "hi");
    assert.equal(r.usage?.inputTokens, 10);
    assert.equal(r.usage?.outputTokens, 5);
  });

  it("用量欄位名相容（prompt/completion 寫法）", () => {
    const r = mustText(parseAgyResult(
      JSON.stringify({ status: "SUCCESS", response: "x", usage: { promptTokens: 3, completionTokens: 7 } }),
      "",
      0,
    ));
    assert.equal(r.usage?.inputTokens, 3);
    assert.equal(r.usage?.outputTokens, 7);
  });

  it("非 SUCCESS 但有 response 也接受", () => {
    const r = mustText(parseAgyResult(JSON.stringify({ status: "DONE", response: "ok" }), "", 0));
    assert.equal(r.text, "ok");
  });

  it("ERROR envelope 帶出 detail；auth 相關加登入提示", () => {
    const msg = mustError(parseAgyResult(
      JSON.stringify({ status: "ERROR", error: "authentication required, please run agy login" }),
      "",
      1,
    ));
    assert.match(msg, /authentication required/);
    assert.match(msg, /完成 Google 帳戶登入/);
  });

  it("error 物件形式也解析 message", () => {
    const msg = mustError(parseAgyResult(
      JSON.stringify({ status: "ERROR", error: { code: 401, message: "unauthorized" } }),
      "",
      1,
    ));
    assert.match(msg, /unauthorized/);
    assert.match(msg, /完成 Google 帳戶登入/);
  });

  it("INTERRUPTED 與 denied_actions（含處置指引）", () => {
    assert.match(mustError(parseAgyResult(JSON.stringify({ status: "INTERRUPTED" }), "", 1)), /中斷/);
    const denied = mustError(parseAgyResult(
      JSON.stringify({ status: "SUCCESS", response: " ", denied_actions: [{ action: "write_file" }] }),
      "",
      0,
    ));
    assert.match(denied, /write_file/);
    assert.match(denied, /permissions\.allow/);
  });

  it("keyring 相關也給登入替代方案", () => {
    const msg = mustError(parseAgyResult("", "could not unlock keyring", 1));
    assert.match(msg, /GEMINI_API_KEY/);
  });

  it("非 JSON：帶 stderr；auth 相關加提示", () => {
    const msg = mustError(parseAgyResult("not json", "Error: not authenticated, run agy", 1));
    assert.match(msg, /not authenticated/);
    assert.match(msg, /完成 Google 帳戶登入/);
  });

  it("空輸出回 exit code", () => {
    assert.match(mustError(parseAgyResult("", "", 1)), /exit 1/);
  });

  it("未預期的 status 明確報錯", () => {
    assert.match(mustError(parseAgyResult(JSON.stringify({ status: "WEIRD" }), "oops", 0)), /WEIRD/);
  });
});
