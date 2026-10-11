import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用獨立的 settings 路徑，讓 audit.jsonl 落在暫存目錄。
// 必須先設 env 再動態載入（config 在 import 時讀 env）。
const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
process.env.SETTINGS_PATH = join(dir, "settings.json");

const { audit, readAuditEntries, purgeAudit } = await import("../src/audit.js");

function fakeReq(ip = "127.0.0.1"): never {
  return { ip } as never;
}

describe("audit reader / purge", () => {
  it("寫入後可讀回（新的在前），限筆數生效", () => {
    audit(fakeReq(), "login.fail", "admin");
    audit(fakeReq(), "login.success", "admin");
    audit(fakeReq(), "settings.save", "a,b");
    const list = readAuditEntries(2);
    assert.equal(list.length, 2);
    assert.equal(list[0].action, "settings.save", "最新的一筆在前");
    assert.equal(list[1].action, "login.success");
    assert.equal(list[0].ip, "127.0.0.1");
    assert.equal(list[0].detail, "a,b");

    const all = readAuditEntries(100);
    assert.ok(all.length >= 3);
  });

  it("清空後讀不到，且清空本身可再被記錄", () => {
    const removed = purgeAudit();
    assert.ok(removed >= 3);
    assert.equal(readAuditEntries().length, 0);
    audit(fakeReq(), "audit.purge", `removed:${removed}`);
    assert.equal(readAuditEntries().length, 1);
    assert.equal(readAuditEntries()[0].action, "audit.purge");
  });

  it("單行損毀不影響其他紀錄", () => {
    purgeAudit();
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, "壞行\n" + JSON.stringify({ time: "t", ip: "1", user: "u", action: "ok.one" }) + "\n");
    const list = readAuditEntries();
    assert.equal(list.length, 1);
    assert.equal(list[0].action, "ok.one");
  });

  it("檔案不存在回空陣列", () => {
    rmSync(join(dir, "audit.jsonl"), { force: true });
    assert.deepEqual(readAuditEntries(), []);
    assert.equal(purgeAudit(), 0);
  });

  it("真的寫進 audit.jsonl", () => {
    audit(fakeReq("9.9.9.9"), "marker.file", "x");
    const raw = readFileSync(join(dir, "audit.jsonl"), "utf8");
    assert.match(raw, /marker\.file/);
    assert.match(raw, /9\.9\.9\.9/);
  });
});
