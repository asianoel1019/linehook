import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dnsLookup, formatDns } from "../src/skills/net/index.js";
import { parseRecurring } from "../src/skills/remind/index.js";
import remindSkill from "../src/skills/remind/index.js";
import type { SkillContext, SkillWatchView } from "../src/skills/types.js";

describe("net formatDns", () => {
  it("A/AAAA/MX 全有", () => {
    const text = formatDns({
      host: "example.com",
      a: ["1.2.3.4", "5.6.7.8"],
      aaaa: ["2606:4700::1"],
      mx: ["mx1.example.com（10）"],
      error: "",
    });
    assert.match(text, /🌐 example\.com/);
    assert.match(text, /A：1\.2\.3\.4、5\.6\.7\.8/);
    assert.match(text, /AAAA：2606:4700::1/);
    assert.match(text, /MX：mx1\.example\.com（10）/);
  });

  it("完全查無時給提示", () => {
    const text = formatDns({ host: "nodomain.invalid", a: [], aaaa: [], mx: [], error: "查無 A 紀錄" });
    assert.match(text, /DNS 查無 nodomain\.invalid 的紀錄（查無 A 紀錄）。/);
  });

  it("localhost 離線可解析（A 有值、MX 空）", async () => {
    const r = await dnsLookup("localhost");
    assert.equal(r.host, "localhost");
    assert.ok(r.a.length > 0 || r.aaaa.length > 0);
  });
});

describe("remind 假日跳過", () => {
  it("每天提醒附假日跳過旗標", () => {
    const r = parseRecurring("每天 09:00 晨會 假日跳過");
    assert.ok(r);
    assert.equal(r?.content, "晨會");
    assert.equal(r?.skipHoliday, true);
  });

  it("「放假不響」也算跳過", () => {
    const r = parseRecurring("每天 09:00 晨會 放假不響");
    assert.equal(r?.skipHoliday, true);
    assert.equal(r?.content, "晨會");
  });

  it("沒說的預設不跳過", () => {
    assert.equal(parseRecurring("每天 09:00 晨會")?.skipHoliday, false);
  });

  it("週末專用提醒不吃跳過旗標（會濾掉自己）", () => {
    const r = parseRecurring("週末 10:00 爬山 假日跳過");
    assert.equal(r?.skipHoliday, false);
  });

  it("註冊時 args 帶 skipHoliday 且清單顯示徽章", async () => {
    const replies: string[] = [];
    const watches: Array<{
      task: string;
      cron?: string;
      everyMinutes?: number;
      at?: string;
      args?: Record<string, string | number | boolean>;
    }> = [];
    const ctx = {
      text: "",
      args: "每天 09:00 晨會 假日跳過",
      fromName: "tester",
      chat: "c1",
      fromMid: "u1",
      config: {},
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "sched",
      watch: (opts: {
        task: string;
        state?: Record<string, unknown>;
        cron?: string;
        args?: Record<string, string | number | boolean>;
      }) => {
        watches.push(opts);
        return `task:${opts.task}`;
      },
      unwatch: () => true,
      watches: () =>
        watches.map<SkillWatchView>((w) => ({
          id: `task:${w.task}`,
          task: w.task,
          cron: w.cron ?? "",
          runAt: "2026-10-11T09:00:00",
          args: w.args ?? {},
        })),
      taskState: () => undefined,
    } as unknown as SkillContext;

    await remindSkill.run(ctx);
    assert.match(replies[0], /假日不推播/);
    assert.equal(watches[0]?.args?.skipHoliday, "1");

    ctx.args = "清單";
    await remindSkill.run(ctx);
    assert.match(replies[replies.length - 1], /假日跳過/);
  });
});
