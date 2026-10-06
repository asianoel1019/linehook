import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { currentSettings, loadSettings, saveSettings } from "../src/settings.js";

/**
 * LINE 個人帳號的兩件設定（都是「設定頁可改」後需要重新登入才生效）：
 * - `line.storagePath`：session 檔位置（對應 WhatsApp Web 的 webAuthPath）
 * - `line.mode`：personal / official 擇一（對應 WhatsApp 的 cloud / web）
 *
 * 重點在 `loadSettings()` 的淺合併：舊 settings.json 沒有這些欄位時，
 * 必須沿用 .env 帶來的初始值，不能被預設值衝掉。
 */
describe("LINE 設定（session 路徑 + 帳號模式）", () => {
  const originalPath = config.settingsPath;
  const originalLine = { ...config.line, official: { ...config.line.official } };
  const baseStoragePath = config.line.storagePath;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "settings-line-"));
    config.settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    config.settingsPath = originalPath;
    config.line = { ...originalLine, official: { ...originalLine.official } };
    rmSync(dir, { recursive: true, force: true });
  });

  it("currentSettings 帶出 mode / storagePath / official（供設定頁顯示）", () => {
    const s = currentSettings();
    assert.equal(s.line.mode, config.line.mode);
    assert.equal(s.line.storagePath, config.line.storagePath);
    assert.equal(typeof s.line.official.channelAccessToken, "string");
    assert.deepEqual(s.line.official.targets, config.line.official.targets);
  });

  it("舊 settings.json 缺少 storagePath / official 時沿用初始值，不被預設值衝掉", () => {
    writeFileSync(config.settingsPath, JSON.stringify({ schemaVersion: 1, line: { device: "ANDROID" } }));
    loadSettings();

    assert.equal(config.line.device, "ANDROID", "檔案裡有的欄位要生效");
    assert.equal(config.line.storagePath, baseStoragePath, "檔案沒有的欄位要沿用 .env 初始值");
    assert.equal(config.line.official.channelAccessToken, "");
    assert.equal(config.line.mode, "personal");
  });

  it("saveSettings → 破壞記憶體狀態 → loadSettings 能還原 mode / storagePath / official", () => {
    const base = currentSettings();
    saveSettings({
      ...base,
      line: {
        ...base.line,
        mode: "official",
        storagePath: join(dir, "storage.json"),
        official: {
          channelAccessToken: "unit-test-token",
          channelSecret: "unit-test-secret",
          webhookUrl: "https://example.com/line-official/webhook",
          targets: { 我: "U1234567890abcdef1234567890abcdef" },
        },
      },
    });

    config.line.mode = "personal";
    config.line.storagePath = "./storage.json";
    config.line.official.channelAccessToken = "";
    config.line.official.targets = {};

    loadSettings();

    assert.equal(config.line.mode, "official");
    assert.equal(config.line.storagePath, join(dir, "storage.json"));
    assert.equal(config.line.official.channelAccessToken, "unit-test-token");
    assert.equal(config.line.official.webhookUrl, "https://example.com/line-official/webhook");
    assert.deepEqual(config.line.official.targets, { 我: "U1234567890abcdef1234567890abcdef" });
  });
});
