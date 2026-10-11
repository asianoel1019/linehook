import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certDaysLeft, hostOf, isOkCode } from "../src/skills/website/index.js";
import websiteSkill from "../src/skills/website/index.js";
import type { SkillContext, SkillTaskContext } from "../src/skills/types.js";

describe("website helpers", () => {
  it("isOkCode：2xx/3xx 正常，其餘異常", () => {
    assert.equal(isOkCode(200), true);
    assert.equal(isOkCode(301), true);
    assert.equal(isOkCode(404), false);
    assert.equal(isOkCode(500), false);
    assert.equal(isOkCode(0), false);
  });

  it("hostOf 取出 host（IDN 會被正規成 punycode）", () => {
    assert.equal(hostOf("https://example.com:8443/x?y=1"), "example.com:8443");
    assert.equal(hostOf("http://例.com"), "xn--fsq.com");
    assert.equal(hostOf("亂打完"), "亂打完");
  });

  it("certDaysLeft 解析憑證到期", () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(certDaysLeft("2027-01-01T00:00:00Z", now), 365);
    assert.equal(certDaysLeft("2026-01-01T00:00:00Z", now), 0);
    assert.equal(certDaysLeft("2025-01-01T00:00:00Z", now), -365);
    assert.equal(certDaysLeft("", now), null);
    assert.equal(certDaysLeft(undefined, now), null);
    assert.equal(certDaysLeft("not a date", now), null);
  });
});

describe("website run() 單次探測", () => {
  it("內網位址被 SSRF 阻擋 → 回異常", async () => {
    const replies: string[] = [];
    // 127.0.0.1 直接被 blockPrivate 擋下，不需真實連線。
    await websiteSkill.run({
      text: "",
      args: "https://127.0.0.1:1/x",
      fromName: "t",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => false,
      watches: () => [],
      taskState: () => undefined,
    } as unknown as SkillContext);
    assert.match(replies[0], /^🔴/);
  });

  it("沒有網址給用法", async () => {
    const replies: string[] = [];
    await websiteSkill.run({
      text: "",
      args: "",
      fromName: "t",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "",
      watch: () => "",
      unwatch: () => false,
      watches: () => [],
      taskState: () => undefined,
    } as unknown as SkillContext);
    assert.match(replies[0], /單次探測/);
  });
});

describe("website onTask", () => {
  function ctx(
    state: Record<string, unknown>,
  ): SkillTaskContext & { replies: string[]; saved: Record<string, unknown>[] } {
    const replies: string[] = [];
    const saved: Record<string, unknown>[] = [];
    return {
      taskId: "t1",
      task: "monitor",
      chat: "c1",
      fromName: "t",
      config: { timeoutMs: "2000" },
      args: {},
      state,
      saveState: async (patch) => {
        saved.push(patch);
      },
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      replies,
      saved,
    };
  }

  it("新站第一輪異常就推播，且不重複推", async () => {
    const c = ctx({ sites: ["http://127.0.0.1:1/a"], status: {}, cert: {} });
    await websiteSkill.onTask!(c);
    assert.equal(c.replies.length, 1);
    assert.match(c.replies[0], /網站異常：127.0.0.1:1/);
    assert.equal((c.saved[0]?.status as Record<string, { ok: boolean }>)["http://127.0.0.1:1/a"].ok, false);

    // 第二輪同樣失敗 → 已記錄過就不再推
    const c2 = ctx({ sites: ["http://127.0.0.1:1/a"], status: c.saved[0]?.status ?? {}, cert: {} });
    await websiteSkill.onTask!(c2);
    assert.equal(c2.replies.filter((r) => r.includes("異常")).length, 0);
  });

  it("空清單不做事", async () => {
    const c = ctx({ sites: [] });
    await websiteSkill.onTask!(c);
    assert.equal(c.replies.length, 0);
    assert.equal(c.saved.length, 0);
  });
});
