import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { redactText, resetRedactCache } from "../src/redact.js";

const savedApiTokens = [...config.apiTokens];
const savedSkills = [...config.skills];

after(() => {
  config.apiTokens = savedApiTokens;
  config.skills = savedSkills;
  resetRedactCache();
});

describe("P1-3 secrets 遮蔽", () => {
  it("精確值：設定的 token 原文遮掉", () => {
    config.apiTokens = [{ name: "t", token: "tok-secret-abc123456", scopes: ["admin"] }];
    resetRedactCache();
    assert.equal(redactText("call with tok-secret-abc123456 done"), "call with **** done");
    // 短值（<8）不收錄，避免誤傷
    config.apiTokens = [{ name: "t", token: "abc", scopes: [] }];
    resetRedactCache();
    assert.equal(redactText("call with abc done"), "call with abc done");
  });

  it("形狀：Bearer／query key／URL 密碼", () => {
    resetRedactCache();
    assert.equal(redactText("Authorization: Bearer abcdef123456"), "Authorization: Bearer ****");
    assert.equal(
      redactText("https://x.com/api?key=SECRETVALUE123&format=json"),
      "https://x.com/api?key=****&format=json",
    );
    assert.equal(redactText("postgres://u:s3cr3tpass@host/db"), "postgres://u:****@host/db");
  });

  it("形狀：供應商 key 與 TG token", () => {
    resetRedactCache();
    assert.ok(!redactText("key sk-abcdefghijklmnopqrstuvwx ok").includes("sk-abcdef"));
    assert.ok(!redactText("bot 123456:ABCdefGHIjklMNOpqrSTUvwxyz ok").includes("ABCdef"));
    assert.ok(!redactText("gkey AIzaSyD12345678901234567890123456789 ok").includes("AIza"));
  });

  it("形狀：URL token 片段（長度門檻防誤傷）", () => {
    resetRedactCache();
    assert.equal(redactText("POST /webhook/abcdef1234567890/line"), "POST /webhook/****/line");
    assert.equal(redactText("id abc123 正常"), "id abc123 正常");
  });

  it("技能設定的 secret key 也收錄，一般值不碰", () => {
    config.skills = [
      ...(config.skills ?? []),
      { id: "t1", enabled: false, trigger: "t", config: { cwaKey: "cwa-secret-value-99", city: "Taipei" } },
    ] as typeof config.skills;
    resetRedactCache();
    assert.ok(!redactText("key=cwa-secret-value-99").includes("cwa-secret"));
    assert.ok(redactText("城市 Taipei 天氣").includes("Taipei"));
  });

  it("誤判檢查：日常文字原樣通過＋冪等", () => {
    resetRedactCache();
    const plain = "台北天氣如何？api key missing，請到設定頁填寫";
    assert.equal(redactText(plain), plain);
    const once = redactText("Bearer abcdef123456");
    assert.equal(redactText(once), once);
    assert.equal(redactText(""), "");
  });
});
