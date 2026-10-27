import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  checkOutbound,
  fetchJson,
  getOutboundBlocked,
  resetOutboundBlocked,
} from "../src/net.js";

const savedAllow = [...config.outboundAllowlist];
const savedBlock = [...config.outboundBlocklist];
const savedEnforce = config.outboundEnforce;

after(() => {
  config.outboundAllowlist = savedAllow;
  config.outboundBlocklist = savedBlock;
  config.outboundEnforce = savedEnforce;
  resetOutboundBlocked();
});

describe("P1-2 出站網域管制", () => {
  it("預設：無名單全部放行", () => {
    config.outboundAllowlist = [];
    config.outboundBlocklist = [];
    config.outboundEnforce = false;
    assert.equal(checkOutbound("https://anything.example.com/x").action, "allow");
  });

  it("封鎖清單：完全＋子網域都擋（觀察模式也擋）", () => {
    config.outboundAllowlist = [];
    config.outboundBlocklist = ["evil.example.com"];
    config.outboundEnforce = false;
    assert.equal(checkOutbound("https://evil.example.com/steal").action, "block");
    assert.equal(checkOutbound("https://sub.evil.example.com/x").action, "block");
    assert.equal(checkOutbound("https://not-evil.example.com/x").action, "allow");
    assert.equal(checkOutbound("https://evil.example.com.evil2.com/x").action, "allow");
  });

  it("白名單：強制擋、觀察只記", () => {
    config.outboundBlocklist = [];
    config.outboundAllowlist = ["tdx.transportdata.tw"];
    config.outboundEnforce = true;
    assert.equal(checkOutbound("https://tdx.transportdata.tw/api/x").action, "allow");
    const v = checkOutbound("https://unknown.example.com/x");
    assert.equal(v.action, "block");
    assert.ok(v.reason.includes("強制"));
    config.outboundEnforce = false;
    const v2 = checkOutbound("https://unknown.example.com/x");
    assert.equal(v2.action, "observe");
  });

  it("封鎖優先於白名單", () => {
    config.outboundAllowlist = ["example.com"];
    config.outboundBlocklist = ["bad.example.com"];
    config.outboundEnforce = true;
    assert.equal(checkOutbound("https://bad.example.com/x").action, "block");
    assert.equal(checkOutbound("https://good.example.com/x").action, "allow");
  });

  it("fetchJson 被擋下丟 BlockedHostError＋記帳", async () => {
    resetOutboundBlocked();
    config.outboundAllowlist = ["tdx.transportdata.tw"];
    config.outboundBlocklist = [];
    config.outboundEnforce = true;
    await assert.rejects(fetchJson("https://blocked.example.com/x"), /出站網域管制/);
    const blocked = getOutboundBlocked();
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].host, "blocked.example.com");
    assert.equal(blocked[0].count, 1);
  });

  it("觀察模式：放行但記 dryrun 指標", async () => {
    resetOutboundBlocked();
    config.outboundAllowlist = ["tdx.transportdata.tw"];
    config.outboundBlocklist = [];
    config.outboundEnforce = false;
    // 未達網（127.0.0.1 不在白名單→observe），重點是不丟管制錯誤
    await assert.rejects(
      fetchJson("http://127.0.0.1:1/x", undefined, { timeoutMs: 500 }),
      (e: unknown) => e instanceof Error && !e.message.includes("出站網域管制"),
    );
    assert.equal(getOutboundBlocked().length, 0);
  });
});
