import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { seenInbound } from "../src/messaging/dedup.js";
import { persistInbound, countPersistedInbound } from "../src/messaging/inbox.js";
import { writeDeadLetter, readDeadLetters } from "../src/deadletter.js";

describe("seenInbound", () => {
  it("首次回 false，重複回 true；不同平台互不干擾", () => {
    const id = `u-${Date.now()}-1`;
    assert.equal(seenInbound("telegram", id), false);
    assert.equal(seenInbound("telegram", id), true);
    assert.equal(seenInbound("whatsapp", id), false);
  });

  it("無 id 不去重", () => {
    assert.equal(seenInbound("line", undefined), false);
    assert.equal(seenInbound("line", undefined), false);
  });
});

describe("persistInbound", () => {
  it("寫檔且可計數", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-"));
    const prev = config.inboundQueuePath;
    config.inboundQueuePath = join(dir, "inbound-queue.jsonl");
    try {
      const before = countPersistedInbound();
      persistInbound("teams", { type: "message", text: "hi" });
      assert.equal(countPersistedInbound(), before + 1);
      const lines = readFileSync(config.inboundQueuePath, "utf8").split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      assert.equal(last.platform, "teams");
      assert.equal(last.body.text, "hi");
    } finally {
      config.inboundQueuePath = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deadletter", () => {
  it("寫入後可讀回", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    const prev = config.deadletterPath;
    config.deadletterPath = join(dir, "deadletter.jsonl");
    try {
      writeDeadLetter({ platform: "line", kind: "send", to: ["小明"], summary: "text", error: "boom" });
      const list = readDeadLetters(10);
      assert.equal(list.length, 1);
      assert.equal(list[0].platform, "line");
      assert.equal(list[0].error, "boom");
      assert.ok(list[0].time);
    } finally {
      config.deadletterPath = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
