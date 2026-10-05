import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { dispatchIncoming, type DispatchDeps } from "../src/messaging/dispatch.js";

function makeDeps(): DispatchDeps & { replies: string[]; enqueued: Array<{ to: string; text: string }> } {
  const replies: string[] = [];
  const enqueued: Array<{ to: string; text: string }> = [];
  const deps: DispatchDeps & { replies: string[]; enqueued: Array<{ to: string; text: string }> } = {
    replies,
    enqueued,
    platform: "test",
    replyTo: async (_chat, text) => { replies.push(text); },
    sendAdvanced: async () => {},
    sendMedia: async () => {},
    schedule: () => ({}) as never,
    scheduleSkillTask: () => ({}) as never,
    listSkillTasks: () => [],
    readTaskState: () => undefined,
    saveTaskState: () => true,
    cancelScheduledTask: () => true,
    enqueueText: async (to, text) => { enqueued.push({ to, text }); },
    getQueueStats: () => ({ pending: 0, running: false }),
    listScheduled: () => [],
  };
  return deps;
}

const saved = {
  assistant: { ...config.assistant },
  commands: { ...config.commands, allowFrom: [...config.commands.allowFrom] },
  forward: [...config.forward],
  skills: [...config.skills],
};

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: true, prefix: "!", allowFrom: [] };
  config.forward = [];
  config.skills = [];
});

afterEach(() => {
  config.assistant = { ...saved.assistant };
  config.commands = { ...saved.commands, allowFrom: [...saved.commands.allowFrom] };
  config.forward = [...saved.forward];
  config.skills = [...saved.skills];
});

const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  chat: "c1",
  fromId: "u1",
  fromName: "tester",
  chatName: "",
  text,
  ...extra,
});

describe("dispatchIncoming", () => {
  it("空對話或空文字不做任何事", async () => {
    const d = makeDeps();
    await dispatchIncoming({ chat: "", fromId: "u", fromName: "", chatName: "", text: "hi" }, d);
    await dispatchIncoming(msg(""), d);
    assert.deepEqual(d.replies, []);
    assert.deepEqual(d.enqueued, []);
  });

  it("相同 messageId 只處理一次（去重）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "dup-1" }), d);
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "dup-1" }), d);
    assert.equal(d.replies.length, 1);
  });

  it("Layer 1：只喊助理名回技能清單", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "l1-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /可用技能|沒有可用技能/);
  });

  it("指令 !id 回 chat 與 from", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("!id", { messageId: "cmd-1" }), d);
    assert.deepEqual(d.replies, ["chat=c1\nfrom=u1"]);
  });

  it("指令白名單擋陌生人", async () => {
    const d = makeDeps();
    config.commands.allowFrom = ["somebody-else"];
    await dispatchIncoming(msg("!id", { messageId: "cmd-2" }), d);
    assert.deepEqual(d.replies, []);
  });

  it("未知指令回提示", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("!nope", { messageId: "cmd-3" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /未知指令/);
  });

  it("轉發規則 match=all 轉發並帶前綴", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.forward = [{
      id: "r1", enabled: true, match: "all", keyword: "",
      source: "", target: "u9", includeSender: true, prefix: "[Fwd]",
    }];
    await dispatchIncoming(msg("hello world", { messageId: "fw-1", chatName: "群組" }), d);
    assert.deepEqual(d.enqueued, [{ to: "u9", text: "[Fwd] [群組] hello world" }]);
  });

  it("轉發規則 source 不符不轉發；非法 regex 不炸", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.forward = [{
      id: "r2", enabled: true, match: "regex", keyword: "([",
      source: "other-chat", target: "u9", includeSender: false, prefix: "",
    }];
    await dispatchIncoming(msg("hello", { messageId: "fw-2" }), d);
    assert.deepEqual(d.enqueued, []);
  });

  it("技能白名單擋陌生人（無需載入技能定義）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.skills = [{ id: "ghost", enabled: true, trigger: "x", allowedUsers: ["boss"], config: {} }];
    await dispatchIncoming(msg("anything", { messageId: "wl-1" }), d);
    assert.deepEqual(d.replies, []);
    assert.deepEqual(d.enqueued, []);
  });

  it("技能例外不會擊倒後續流程", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    // ghost 沒有定義會被跳過；重點是流程不丟例外
    config.skills = [{ id: "ghost", enabled: true, trigger: "x", allowedUsers: [], config: {} }];
    await dispatchIncoming(msg("anything", { messageId: "ex-1" }), d);
    assert.deepEqual(d.enqueued, []);
  });
});
