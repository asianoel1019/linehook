import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probePlatform } from "../src/monitor/platform-probe.js";

describe("probePlatform 不需網路的失敗路徑", () => {
  it("未填 token 時明確擋下（不打 API）", async () => {
    for (const platform of ["telegram", "discord", "teams", "line", "whatsapp"] as const) {
      const r = await probePlatform(platform, {});
      assert.equal(r.ok, false, platform);
      assert.match(r.detail, /尚未填|尚未填|尚未填/);
    }
  });

  it("未知平台回錯誤", async () => {
    const r = await probePlatform("line", {});
    assert.equal(r.ok, false);
    assert.match(r.detail, /尚未填 Channel access token/);
    const unknown = await probePlatform("irc", {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /尚不支援探測平台/);
  });

  it("缺一半憑證（WhatsApp）時指出缺哪個", async () => {
    const r = await probePlatform("whatsapp", { accessToken: "EAA-only-token" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /Phone Number ID/);
  });
});
