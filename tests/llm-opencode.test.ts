import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOpencodeResult } from "../src/skills/llm.js";

function mustText(r: unknown): { text: string } {
  if (!r || typeof r !== "object" || !("text" in r)) throw new Error(`預期成功卻拿到：${JSON.stringify(r)}`);
  return r as { text: string };
}

function mustError(r: unknown): string {
  if (!r || typeof r !== "object" || !("error" in r)) throw new Error(`預期失敗卻拿到：${JSON.stringify(r)}`);
  return (r as { error: string }).error;
}

const ev = (o: unknown): string => JSON.stringify(o);

describe("parseOpencodeResult", () => {
  it("text 事件累加＋step_finish 用量", () => {
    const out = [
      ev({ type: "step_start", sessionID: "ses_1" }),
      ev({ type: "text", part: { type: "text", text: "Hello " } }),
      ev({ type: "text", part: { type: "text", text: "world" } }),
      ev({
        type: "step_finish",
        part: { type: "step-finish", reason: "stop", tokens: { input: 100, output: 20 }, cost: 0.001 },
      }),
    ].join("\n");
    const r = mustText(parseOpencodeResult(out, "", 0));
    assert.equal(r.text, "Hello world");
  });

  it("error 事件帶出訊息", () => {
    const out = ev({ type: "error", error: { name: "APIError", data: { message: "Rate limit exceeded" } } });
    assert.match(mustError(parseOpencodeResult(out, "", 1)), /Rate limit exceeded/);
  });

  it("只有 step_start（事件遺失）→ 明確報錯而非空回", () => {
    const out = ev({ type: "step_start", sessionID: "ses_1" });
    assert.match(mustError(parseOpencodeResult(out, "", 0)), /未回傳內容/);
  });

  it("非 JSON 輸出（舊版 CLI）→ 退回純文字並去掉狀態列", () => {
    const r = mustText(parseOpencodeResult("> build · gemini-4-argon\nprod-ok\n", "", 0));
    assert.equal(r.text, "prod-ok");
  });

  it("空輸出回 exit code；stderr 優先呈現", () => {
    assert.match(mustError(parseOpencodeResult("", "", 1)), /exit 1/);
    assert.match(mustError(parseOpencodeResult("", "boom happened", 1)), /boom happened/);
  });
});
