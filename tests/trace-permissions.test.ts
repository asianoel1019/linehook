import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import {
  finishTrace,
  newTraceId,
  readTraces,
  resetActiveTraces,
  setTracePath,
  startTrace,
  traceEvent,
  withTrace,
} from "../src/trace.js";
import { runWithExecContext, currentExecContext } from "../src/exec-context.js";
import { describePermissions, parsePermissions } from "../src/skills/install.js";

const savedSkillsPath = config.skillsPath;
const workDir = join(tmpdir(), `trace-${process.pid}`);
const traceFile = join(workDir, "traces.jsonl");

before(() => {
  // 隔離落檔位置（測試的 trace 不寫進專案根目錄）。
  setTracePath(traceFile);
  resetActiveTraces();
});

after(() => {
  setTracePath(null);
  resetActiveTraces();
  config.skillsPath = savedSkillsPath;
});

describe("P2 執行上下文（AsyncLocalStorage）", () => {
  it("巢狀時內層覆蓋外層、離開後還原", () => {
    assert.deepEqual(currentExecContext(), {});
    runWithExecContext({ traceId: "t1", skillId: "a" }, () => {
      assert.equal(currentExecContext().traceId, "t1");
      runWithExecContext({ skillId: "b" }, () => {
        assert.equal(currentExecContext().skillId, "b");
        assert.equal(currentExecContext().traceId, "t1", "外層欄位要保留");
      });
      assert.equal(currentExecContext().skillId, "a");
    });
    assert.deepEqual(currentExecContext(), {});
  });

  it("穿透 await（技能內部呼叫仍帶上下文）", async () => {
    await runWithExecContext({ skillId: "weather" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(currentExecContext().skillId, "weather");
    });
  });
});

describe("P2 鏈路追蹤", () => {
  it("事件會聚到同一條 trace 並落檔", () => {
    resetActiveTraces();
    const traceId = startTrace("line", "c1", "u1", "測試訊息");
    withTrace(traceId, () => {
      traceEvent("skill", { skill: "lunar", detail: "觸發" });
      traceEvent("skill", { skill: "lunar", ok: true, detail: "完成" });
      traceEvent("forward", { ok: false, detail: "轉發失敗" });
      finishTrace();
    });
    const list = readTraces(10);
    const rec = list.find((t) => t.traceId === traceId);
    assert.ok(rec);
    assert.equal(rec.platform, "line");
    assert.equal(rec.chat, "c1");
    assert.equal(rec.text, "測試訊息");
    assert.equal(rec.events.length, 3);
    assert.equal(rec.events[0].skill, "lunar");
    assert.equal(rec.events[2].ok, false);
  });

  it("沒有 trace 時 traceEvent 不會炸", () => {
    assert.doesNotThrow(() => traceEvent("skill", { skill: "x" }));
    assert.doesNotThrow(() => finishTrace());
  });

  it("檔案壞行不影響其他紀錄", () => {
    const path = join(workDir, "traces.jsonl");
    const good = JSON.stringify({ traceId: "ok", time: "t", platform: "line", chat: "c", from: "f", text: "x", events: [] });
    writeFileSync(path, "壞行\n" + good + "\n", "utf8");
    const list = readTraces(10);
    assert.equal(list.length, 1);
    assert.equal(list[0].traceId, "ok");
  });

  it("traceId 唯一", () => {
    const ids = new Set([newTraceId(), newTraceId(), newTraceId()]);
    assert.equal(ids.size, 3);
  });
});

describe("P2 技能權限宣告", () => {
  it("解析正常宣告", () => {
    const p = parsePermissions({
      network: ["TDX.TransportData.TW", "api.open-meteo.com"],
      files: "temp",
      readOtherSkills: true,
      callOtherSkills: false,
    });
    assert.ok(p);
    assert.deepEqual(p.network, ["tdx.transportdata.tw", "api.open-meteo.com"]);
    assert.equal(p.files, "temp");
    assert.equal(p.readOtherSkills, true);
    assert.equal(p.callOtherSkills, undefined);
  });

  it("壞格式回 null（不安裝失敗）", () => {
    assert.equal(parsePermissions(null), null);
    assert.equal(parsePermissions("x"), null);
    assert.equal(parsePermissions([]), null);
    assert.equal(parsePermissions({ files: "weird" }), null);
    assert.equal(parsePermissions({}), null);
  });

  it("人話摘要", () => {
    assert.equal(describePermissions(null), "未宣告");
    assert.equal(describePermissions({ network: ["a.com"] }), "連外：a.com");
    assert.equal(describePermissions({ files: "data", callOtherSkills: true }), "寫檔：資料目錄；呼叫其他技能");
  });
});
