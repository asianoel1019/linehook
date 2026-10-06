import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { buildMediaPath, mimeForName, resolveMediaFile, toPublicMediaUrl, verifyMediaSignature } from "../src/media-url.js";

describe("media-url", () => {
  const original = { uploadsPath: config.uploadsPath, cachePath: config.cachePath, hmacSecret: config.hmacSecret, mediaPublicUrl: config.mediaPublicUrl };
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mediaurl-"));
    config.uploadsPath = join(dir, "uploads");
    config.cachePath = join(dir, "cache");
    mkdirSync(config.uploadsPath, { recursive: true });
    config.hmacSecret = "unit-test-secret";
    config.mediaPublicUrl = "https://hook.example.com";
  });

  afterEach(() => {
    config.uploadsPath = original.uploadsPath;
    config.cachePath = original.cachePath;
    config.hmacSecret = original.hmacSecret;
    config.mediaPublicUrl = original.mediaPublicUrl;
    rmSync(dir, { recursive: true, force: true });
  });

  it("簽章往返：正確路徑放行，改名／過期／超長命／格式錯都擋", () => {
    const now = Math.floor(Date.now() / 1000);
    const { exp, sig } = buildMediaPath("photo.png", now);
    assert.equal(verifyMediaSignature(exp, sig, "photo.png", now), true);
    assert.equal(verifyMediaSignature(exp, sig, "other.png", now), false, "換檔案名稱要失敗");
    assert.equal(verifyMediaSignature(exp - 1, sig, "photo.png", now), false, "過期要失敗");
    assert.equal(verifyMediaSignature(now + 8 * 24 * 3600, sig, "photo.png", now), false, "超長壽命要失敗");
    assert.equal(verifyMediaSignature(exp, "zz", "photo.png", now), false, "非 64 碼 hex 要失敗");
    assert.equal(verifyMediaSignature(Number.NaN, sig, "photo.png", now), false);
  });

  it("金鑰不同簽不出同一份簽章", () => {
    const now = Math.floor(Date.now() / 1000);
    const { exp, sig } = buildMediaPath("a.png", now);
    config.hmacSecret = "another-secret";
    assert.equal(verifyMediaSignature(exp, sig, "a.png", now), false);
  });

  it("https 來源原樣回傳（不經過簽章）", () => {
    assert.equal(toPublicMediaUrl("https://cdn.example/x.png"), "https://cdn.example/x.png");
  });

  it("未設定 MEDIA_PUBLIC_URL 時本機檔案明確報錯", () => {
    config.mediaPublicUrl = "";
    assert.throws(() => toPublicMediaUrl("missing.png"), /MEDIA_PUBLIC_URL/);
  });

  it("本機檔案轉成 /media/<exp>/<sig>/<name>", () => {
    writeFileSync(join(config.uploadsPath, "photo.png"), Buffer.from([1, 2, 3]));
    const url = toPublicMediaUrl("photo.png");
    const m = /^https:\/\/hook\.example\.com\/media\/(\d+)\/([0-9a-f]{64})\/(.+)$/.exec(url);
    assert.ok(m, `格式不符：${url}`);
    assert.equal(decodeURIComponent(m[3]), "photo.png");
    assert.equal(verifyMediaSignature(Number(m[1]), m[2], "photo.png"), true);
    assert.equal(resolveMediaFile("photo.png") !== null, true);
  });

  it("data URL 解碼後暫存到上傳目錄再轉連結", () => {
    const url = toPublicMediaUrl("data:image/png;base64,AQIDBA==");
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    assert.match(name, /^data-\d+-[0-9a-f]{12}\.png$/);
    assert.ok(existsSync(join(config.uploadsPath, name)), "應已寫入上傳目錄");
    assert.equal(resolveMediaFile(name) !== null, true);
  });

  it("resolveMediaFile 擋掉路徑穿越與不存在的檔案", () => {
    writeFileSync(join(config.uploadsPath, "ok.txt"), "hi");
    assert.ok(resolveMediaFile("ok.txt"));
    assert.equal(resolveMediaFile("../settings.json"), null);
    assert.equal(resolveMediaFile("nope.txt"), null);
    assert.equal(resolveMediaFile(""), null);
  });

  it("mimeForName 認識常見副檔名，未知回 octet-stream", () => {
    assert.equal(mimeForName("a.PNG"), "image/png");
    assert.equal(mimeForName("b.mp3"), "audio/mpeg");
    assert.equal(mimeForName("c.weird"), "application/octet-stream");
  });
});
