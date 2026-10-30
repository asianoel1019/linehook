import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSkillHarness } from "../src/skills/test-kit.js";
import helloSkill from "../src/skills/hello/index.js";

describe("P2 測試輔助套件 + 教學範例技能", () => {
  it("harness：收集回覆", async () => {
    const h = createSkillHarness({ config: { greeting: "哈囉" } });
    await h.run(helloSkill, "世界");
    assert.deepEqual(h.replies, ["哈囉 世界！"]);
  });

  it("harness：設定值可覆寫（settings 預設）", async () => {
    const h = createSkillHarness({ config: { greeting: "早安" } });
    await h.run(helloSkill, "");
    assert.deepEqual(h.replies, ["早安！"]);
  });

  it("harness：watch 記錄與回覆", async () => {
    const h = createSkillHarness();
    await h.run(helloSkill, "每天 08:00 喝水");
    assert.equal(h.watched.length, 1);
    assert.equal(h.watched[0]?.task, "water");
    assert.equal(h.watched[0]?.opts.at, "08:00");
    assert.ok(h.replies[0]?.includes("08:00"));
  });

  it("harness：watches() 反映已註冊任務、unwatch 可移除", async () => {
    const h = createSkillHarness();
    await h.run(helloSkill, "每天 08:00 喝水");
    assert.equal(h.ctx.watches().length, 1);
    const id = h.ctx.watches()[0]?.id as string;
    assert.equal(h.ctx.unwatch(id), true);
    assert.equal(h.ctx.watches().length, 0);
    assert.equal(h.ctx.unwatch("nope"), false);
  });

  it("harness：一次性排程被收集", async () => {
    const h = createSkillHarness();
    await h.ctx.schedule("五分鐘後", Date.now() + 1000);
    assert.equal(h.schedules.length, 1);
    assert.ok(h.schedules[0]?.text.includes("五分鐘後"));
  });

  it("harness：taskCtx 可測 onTask（state 持久化＋同日不重複）", async () => {
    const h = createSkillHarness();
    const tc = h.taskCtx({ args: { text: "喝水" } });
    await helloSkill.onTask?.(tc);
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0]?.includes("喝水"));
    // 同一天再跑不重複
    await helloSkill.onTask?.(h.taskCtx({ args: { text: "喝水" } }));
    assert.equal(h.replies.length, 1);
  });

  it("harness：媒體被收集、關掉的權限不動作", async () => {
    const h = createSkillHarness();
    await h.ctx.sendImage("https://x/a.png", "a.png");
    await h.ctx.sendFile("/tmp/x.pdf", "x.pdf");
    assert.equal(h.media.length, 2);
    assert.equal(h.media[0]?.kind, "image");
    assert.equal(h.media[1]?.kind, "file");

    const h2 = createSkillHarness({ allow: { media: false, reply: false } });
    await h2.ctx.sendImage("https://x/a.png");
    await h2.ctx.reply("不該有");
    assert.equal(h2.media.length, 0);
    assert.equal(h2.replies.length, 0);
  });
});
