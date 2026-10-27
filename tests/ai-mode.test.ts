import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import {
  aiGroupModeOn,
  aiModeTtlMs,
  clearAiMode,
  consumeExpiredAiMode,
  detectAiModeCommand,
  isAiModeActive,
  isGroupChat,
  touchAiMode,
} from "../src/skills/ai/mode.js";
import {
  armAiModeExpiryNotice,
  disarmAiModeTimer,
  dispatchIncoming,
  type AiModeNotifier,
  type DispatchDeps,
} from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

describe("aiModeTtlMs", () => {
  it("缺省 10 分鐘；0/負數/非法關閉；上限一天", () => {
    assert.equal(aiModeTtlMs(undefined), 10 * 60 * 1000);
    assert.equal(aiModeTtlMs({}), 10 * 60 * 1000);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "10" }), 10 * 60 * 1000);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "1" }), 60 * 1000);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "0" }), 0);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "-5" }), 0);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "abc" }), 0);
    assert.equal(aiModeTtlMs({ sessionTtlMin: "99999" }), 24 * 60 * 60 * 1000);
  });
});

describe("aiGroupModeOn", () => {
  it("只有 on（大小寫不限）才開", () => {
    assert.equal(aiGroupModeOn(undefined), false);
    assert.equal(aiGroupModeOn({}), false);
    assert.equal(aiGroupModeOn({ groupMode: "on" }), true);
    assert.equal(aiGroupModeOn({ groupMode: "ON" }), true);
    assert.equal(aiGroupModeOn({ groupMode: "off" }), false);
  });
});

describe("AI 模式狀態", () => {
  it("touch 後啟動中；clear 後關閉；逾時自動失效", () => {
    const chat = "mode-state-chat";
    clearAiMode(chat);
    assert.equal(isAiModeActive(chat), false);
    touchAiMode(chat, 60_000);
    assert.equal(isAiModeActive(chat), true);
    touchAiMode(chat, 60_000, Date.now() - 61_000);
    assert.equal(isAiModeActive(chat), false);
    clearAiMode(chat);
  });

  it("consumeExpiredAiMode：只對逾時回 true 且一次性", () => {
    const chat = "mode-consume-chat";
    clearAiMode(chat);
    assert.equal(consumeExpiredAiMode(chat), false);
    touchAiMode(chat, 60_000);
    assert.equal(consumeExpiredAiMode(chat), false);
    touchAiMode(chat, 60_000, Date.now() - 61_000);
    assert.equal(consumeExpiredAiMode(chat), true);
    assert.equal(consumeExpiredAiMode(chat), false);
    assert.equal(isAiModeActive(chat), false);
  });

  it("ttl<=0 或空對話不寫入", () => {
    touchAiMode("", 60_000);
    touchAiMode("mode-noop-chat", 0);
    assert.equal(isAiModeActive("mode-noop-chat"), false);
  });
});

describe("isGroupChat", () => {
  it("LINE 看 mid 首碼", () => {
    assert.equal(isGroupChat("line", "U1234abcd"), false);
    assert.equal(isGroupChat("line", "C1234abcd"), true);
    assert.equal(isGroupChat("line", "R1234abcd"), true);
    assert.equal(isGroupChat("line", "0123456789abcdef0123456789abcdef"), false);
  });

  it("Telegram 看正負號", () => {
    assert.equal(isGroupChat("telegram", "12345"), false);
    assert.equal(isGroupChat("telegram", "-100123"), true);
  });

  it("WhatsApp 看 @g.us", () => {
    assert.equal(isGroupChat("whatsapp", "886912345678@s.whatsapp.net"), false);
    assert.equal(isGroupChat("whatsapp", "123@g.us"), true);
  });

  it("分不出來的一律視為群組；空字串視為個人", () => {
    assert.equal(isGroupChat("discord", "123456789012345678"), true);
    assert.equal(isGroupChat("teams", "19:xxx@thread.v2"), true);
    assert.equal(isGroupChat("slack", "C123"), true);
    assert.equal(isGroupChat("line", ""), false);
    assert.equal(isGroupChat("LINE", "C1"), true, "平台大小寫不敏感");
  });
});

describe("detectAiModeCommand", () => {
  it("啟動語句（空白大小寫寬容）", () => {
    assert.equal(detectAiModeCommand("啟動AI模式"), "start");
    assert.equal(detectAiModeCommand("啟動AI mode"), "start");
    assert.equal(detectAiModeCommand(" 進入AI模式吧 "), "start");
    assert.equal(detectAiModeCommand("開始ai對話"), "start");
    assert.equal(detectAiModeCommand("打開AI模式"), "start");
    assert.equal(detectAiModeCommand("開啟AI"), "start");
    assert.equal(detectAiModeCommand("ai mode"), "start");
    assert.equal(detectAiModeCommand("AI Mode"), "start");
    assert.equal(detectAiModeCommand("ai模式"), "start");
  });

  it("關閉語句", () => {
    assert.equal(detectAiModeCommand("關閉AI模式"), "stop");
    assert.equal(detectAiModeCommand("關閉aimode"), "stop");
    assert.equal(detectAiModeCommand("結束對話"), "stop");
    assert.equal(detectAiModeCommand("退出AI模式"), "stop");
    assert.equal(detectAiModeCommand("關閉ai"), "stop");
    assert.equal(detectAiModeCommand("aimode關"), "stop");
    assert.equal(detectAiModeCommand("ai模式關"), "stop");
  });

  it("非指令回 null", () => {
    assert.equal(detectAiModeCommand(""), null);
    assert.equal(detectAiModeCommand("今天天氣如何"), null);
    assert.equal(detectAiModeCommand("請問怎麼啟動AI模式"), null);
    assert.equal(detectAiModeCommand("問 台灣最高的山"), null);
  });
});

describe("AI 對話模式 dispatch 整合", () => {
  const savedAssistant = { ...config.assistant };
  const savedCommands = { ...config.commands, allowFrom: [...config.commands.allowFrom] };
  const savedForward = [...config.forward];
  const savedSkills = [...config.skills];
  const savedDeadletter = config.deadletterPath;

  function makeDeps(platform = "line"): DispatchDeps & { replies: string[] } {
    const replies: string[] = [];
    return {
      replies,
      platform: platform as DispatchDeps["platform"],
      replyTo: async (_chat: string, text: string) => {
        replies.push(text);
      },
      sendAdvanced: async () => {},
      sendMedia: async () => {},
      schedule: () => ({}) as never,
      scheduleSkillTask: () => ({}) as never,
      listSkillTasks: () => [],
      readTaskState: () => undefined,
      saveTaskState: () => true,
      cancelScheduledTask: () => true,
      enqueueText: async () => {},
      getQueueStats: () => ({ pending: 0, running: false }),
      listScheduled: () => [],
    };
  }

  const msg = (text: string, chat = "U_mode_user") => ({
    chat,
    fromId: "U_mode_user",
    fromName: "tester",
    chatName: "",
    text,
  });

  const aiEntry = (over: Record<string, string> = {}) => ({
    id: "ai",
    enabled: true,
    trigger: "問",
    allowedUsers: [],
    config: { sessionTtlMin: "10", ...over },
  });

  beforeEach(() => {
    config.assistant = { enabled: true, name: "阿寶" };
    config.commands = { enabled: false, prefix: "!", allowFrom: [] };
    config.forward = [];
    config.skills = [aiEntry()];
    config.deadletterPath = join(tmpdir(), "ai-mode-test-deadletter.jsonl");
    clearAiMode("U_mode_user");
    clearAiMode("C_mode_group");
  });

  afterEach(() => {
    config.assistant = { ...savedAssistant };
    config.commands = { ...savedCommands, allowFrom: [...savedCommands.allowFrom] };
    config.forward = [...savedForward];
    config.skills = [...savedSkills];
    config.deadletterPath = savedDeadletter;
    clearAiMode("U_mode_user");
    clearAiMode("C_mode_group");
  });

  it("前綴啟動指令 → 進入模式並確認", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式"), d);
    assert.match(d.replies[0], /已進入 AI 對話模式/);
    assert.match(d.replies[0], /10 分鐘/);
    assert.equal(isAiModeActive("U_mode_user"), true);
  });

  it("模式內無前綴直問 → 走 ai（此處以缺 key 錯誤回覆證明有跑到）", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式"), d);
    d.replies.length = 0;
    await dispatchIncoming(msg("台灣最高的山"), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /AI 回覆失敗/, "ai.run 有執行（缺 key 在內部回報）");
    assert.equal(isAiModeActive("U_mode_user"), true, "問完仍維持");
  });

  it("到期後下一則訊息只收到已退出通知", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式"), d);
    touchAiMode("U_mode_user", 60_000, Date.now() - 61_000);
    d.replies.length = 0;
    await dispatchIncoming(msg("火車時刻表"), d);
    assert.deepEqual(d.replies, ["已退出AI mode。"]);
    assert.equal(isAiModeActive("U_mode_user"), false);
  });

  it("群組未開放：啟動指令靜默無回應", async () => {
    const d = makeDeps("line");
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式", "C_mode_group"), d);
    assert.deepEqual(d.replies, []);
    assert.equal(isAiModeActive("C_mode_group"), false);
  });

  it("群組開放後可進入", async () => {
    config.skills = [aiEntry({ groupMode: "on" })];
    const d = makeDeps("line");
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式", "C_mode_group"), d);
    assert.match(d.replies[0], /已進入 AI 對話模式/);
    assert.equal(isAiModeActive("C_mode_group"), true);
  });

  it("關閉指令離開；沒開過關閉會告知", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("阿寶請幫忙 關閉AI模式"), d);
    assert.match(d.replies[0], /目前沒有啟動/);
    await dispatchIncoming(msg("阿寶請幫忙 啟動AI模式"), d);
    d.replies.length = 0;
    await dispatchIncoming(msg("關閉AI模式"), d);
    assert.match(d.replies[0], /已離開/);
    assert.equal(isAiModeActive("U_mode_user"), false);
  });
});

describe("AI 模式到期主動通知（timer）", () => {
  it("ttl 到時自動發已退出；重設續命後舊 timer 不發", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      const sent: Array<{ platform: string; chat: string; text: string }> = [];
      const notify: AiModeNotifier = async (platform, chat, text) => {
        sent.push({ platform, chat, text });
      };
      touchAiMode("U_notice_t1", 60_000);
      armAiModeExpiryNotice("line", "U_notice_t1", 60_000, notify);
      mock.timers.tick(59_000);
      await Promise.resolve();
      assert.deepEqual(sent, []);
      // 續命：重設 timer；舊時間點到時不應發送
      touchAiMode("U_notice_t1", 60_000);
      armAiModeExpiryNotice("line", "U_notice_t1", 60_000, notify);
      mock.timers.tick(1000);
      await Promise.resolve();
      assert.deepEqual(sent, []);
      mock.timers.tick(59_000);
      await Promise.resolve();
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { platform: "line", chat: "U_notice_t1", text: "已退出AI mode。" });
      assert.equal(isAiModeActive("U_notice_t1"), false);
    } finally {
      mock.timers.reset();
      disarmAiModeTimer("U_notice_t1");
      clearAiMode("U_notice_t1");
    }
  });

  it("disarm 後到期不發", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      const sent: string[] = [];
      const notify: AiModeNotifier = async (_platform, _chat, text) => {
        sent.push(text);
      };
      touchAiMode("U_notice_t2", 60_000);
      armAiModeExpiryNotice("line", "U_notice_t2", 60_000, notify);
      disarmAiModeTimer("U_notice_t2");
      clearAiMode("U_notice_t2");
      mock.timers.tick(120_000);
      await Promise.resolve();
      assert.deepEqual(sent, []);
    } finally {
      mock.timers.reset();
      disarmAiModeTimer("U_notice_t2");
      clearAiMode("U_notice_t2");
    }
  });
});
