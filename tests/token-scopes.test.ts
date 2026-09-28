import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScopes, tokenHasScope, findApiToken } from "../src/middleware/hmac.js";
import { config } from "../src/config.js";

describe("normalizeScopes", () => {
  it("缺失沿用舊行為（僅發送）", () => {
    assert.deepEqual(normalizeScopes(undefined), ["send"]);
    assert.deepEqual(normalizeScopes("send"), ["send"]);
    assert.deepEqual(normalizeScopes(null), ["send"]);
  });

  it("合法值保留、非法過濾", () => {
    assert.deepEqual(normalizeScopes(["read", "send"]), ["read", "send"]);
    assert.deepEqual(normalizeScopes(["admin", "xxx"]), ["admin"]);
  });

  it("明確空陣列 = 無任何權限", () => {
    assert.deepEqual(normalizeScopes([]), []);
  });
});

describe("tokenHasScope", () => {
  it("admin 隱含所有權限", () => {
    assert.equal(tokenHasScope({ name: "a", scopes: ["admin"] }, "read"), true);
    assert.equal(tokenHasScope({ name: "a", scopes: ["admin"] }, "send"), true);
  });

  it("精確比對", () => {
    assert.equal(tokenHasScope({ name: "a", scopes: ["read"] }, "read"), true);
    assert.equal(tokenHasScope({ name: "a", scopes: ["read"] }, "send"), false);
    assert.equal(tokenHasScope({ name: "a", scopes: [] }, "read"), false);
  });

  it("任一符合即通過", () => {
    assert.equal(tokenHasScope({ name: "a", scopes: ["send"] }, "read", "send"), true);
  });
});

describe("findApiToken", () => {
  const savedToken = config.apiToken;
  const savedTokens = config.apiTokens;
  const req = (auth?: string) =>
    ({ header: (name: string) => (name === "authorization" ? auth : undefined) }) as never;

  it("主 Token 視為僅發送", () => {
    config.apiToken = "main-secret";
    try {
      const found = findApiToken(req("Bearer main-secret"));
      assert.deepEqual(found, { name: "", scopes: ["send"] });
      assert.equal(findApiToken(req("Bearer wrong")), null);
      assert.equal(findApiToken(req(undefined)), null);
    } finally {
      config.apiToken = savedToken;
    }
  });

  it("具名 token 照設定 scopes", () => {
    config.apiTokens = [{ name: "ro", token: "ro-secret", scopes: ["read"] }];
    try {
      const found = findApiToken(req("Bearer ro-secret"));
      assert.deepEqual(found, { name: "ro", scopes: ["read"] });
      assert.equal(tokenHasScope(found!, "send"), false);
    } finally {
      config.apiTokens = savedTokens;
    }
  });

  it("舊資料缺 scopes 預設發送", () => {
    config.apiTokens = [{ name: "legacy", token: "legacy-secret" } as never];
    try {
      const found = findApiToken(req("Bearer legacy-secret"));
      assert.deepEqual(found, { name: "legacy", scopes: ["send"] });
    } finally {
      config.apiTokens = savedTokens;
    }
  });
});
