import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encryptSettings, decryptSettings, isEncryptedEnvelope } from "../src/settings-crypto.js";

describe("settings-crypto", () => {
  const payload = { hmacSecret: "sec", telegram: { botToken: "123:abc" }, n: 42 };

  it("加密後可解密回原物件", () => {
    const env = encryptSettings(payload, "pw123");
    assert.equal(isEncryptedEnvelope(env), true);
    const back = decryptSettings(env, "pw123");
    assert.deepEqual(back, payload);
  });

  it("信封不含明文密鑰", () => {
    const env = encryptSettings(payload, "pw123");
    const json = JSON.stringify(env);
    assert.equal(json.includes("sec"), false);
    assert.equal(json.includes("123:abc"), false);
  });

  it("密碼錯誤會丟錯", () => {
    const env = encryptSettings(payload, "pw123");
    assert.throws(() => decryptSettings(env, "wrong"));
  });

  it("資料被竄改會丟錯（GCM 驗證）", () => {
    const env = encryptSettings(payload, "pw123");
    const tampered = { ...env, data: Buffer.from("hacked").toString("base64") };
    assert.throws(() => decryptSettings(tampered, "pw123"));
  });

  it("空密碼拒絕", () => {
    assert.throws(() => encryptSettings(payload, ""));
  });

  it("一般物件不算信封", () => {
    assert.equal(isEncryptedEnvelope({ hmacSecret: "x" }), false);
    assert.equal(isEncryptedEnvelope(null), false);
    assert.equal(isEncryptedEnvelope({ enc: "aes-256-gcm" }), false);
  });
});
