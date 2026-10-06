import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { capabilitiesFor, degradedCapabilities } from "../src/messaging/capabilities.js";
import {
  LineOfficialService,
  buildLineMessages,
  mediaDurationMs,
  normalizeLineEvent,
  verifyLineSignature,
} from "../src/line-official/client.js";

/** 官方文件「驗證 webhook 簽章」章節的真實範例（body/secret/signature 三者互相吻合）。 */
const DOC_BODY = Buffer.from('{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}', "utf8");
const DOC_SECRET = "8c570fa6dd201bb328f1c1eac23a96d8";
const DOC_SIGNATURE = "GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=";

function wav(seconds: number, byteRate = 8000): Buffer {
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function mp4WithMvhd(timescale: number, duration: number): Buffer {
  const head = Buffer.from("ftypisom....moov", "ascii");
  const payload = Buffer.alloc(20);
  payload.writeUInt8(0, 0); // version 0
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(0, 8);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return Buffer.concat([head, Buffer.from("mvhd", "ascii"), payload]);
}

const resolver = (src: string) => (/^https?:\/\//i.test(src) ? src : `https://cdn.example/${src}`);

describe("verifyLineSignature", () => {
  it("符合官方文件範例", () => {
    assert.equal(verifyLineSignature(DOC_BODY, DOC_SIGNATURE, DOC_SECRET), true);
  });

  it("簽章不符／內容被竄改即失敗", () => {
    assert.equal(verifyLineSignature(DOC_BODY, DOC_SIGNATURE, "wrong-secret"), false);
    assert.equal(verifyLineSignature(Buffer.from('{"destination":"U1","events":[]}'), DOC_SIGNATURE, DOC_SECRET), false);
    assert.equal(verifyLineSignature(DOC_BODY, "AAAA", DOC_SECRET), false);
    assert.equal(verifyLineSignature(DOC_BODY, "", DOC_SECRET), false);
  });

  it("未設定 channel secret 一律拒絕（端點唯一的來源驗證）", () => {
    assert.equal(verifyLineSignature(DOC_BODY, DOC_SIGNATURE, ""), false);
  });
});

describe("normalizeLineEvent", () => {
  it("一對一文字訊息", () => {
    const msg = normalizeLineEvent({
      type: "message",
      replyToken: "rt",
      message: { id: "325708", type: "text", text: "哈囉" },
      source: { type: "user", userId: "U4af4980629..." },
    });
    assert.deepEqual(msg, {
      chat: "U4af4980629...",
      fromId: "U4af4980629...",
      fromName: "U4af4980629...",
      chatName: "",
      text: "哈囉",
      messageId: "325708",
    });
  });

  it("群組訊息 chat 取 groupId、fromId 取使用者", () => {
    const msg = normalizeLineEvent({
      type: "message",
      message: { id: "1", type: "text", text: "hi" },
      source: { type: "group", groupId: "c123", userId: "U456" },
    });
    assert.equal(msg?.chat, "c123");
    assert.equal(msg?.fromId, "U456");
  });

  it("多人房 roomId 優先於 userId", () => {
    const msg = normalizeLineEvent({
      type: "message",
      message: { id: "1", type: "text", text: "hi" },
      source: { type: "room", roomId: "Ra789", userId: "U456" },
    });
    assert.equal(msg?.chat, "Ra789");
  });

  it("非文字訊息／非 message 事件／空文字回 null", () => {
    assert.equal(normalizeLineEvent({ type: "message", message: { id: "1", type: "image" }, source: { userId: "U1" } }), null);
    assert.equal(normalizeLineEvent({ type: "follow", source: { userId: "U1" } }), null);
    assert.equal(normalizeLineEvent({ type: "message", message: { id: "1", type: "text", text: "   " }, source: { userId: "U1" } }), null);
    assert.equal(normalizeLineEvent({ type: "message", message: { id: "1", type: "text", text: "x" } }), null);
    assert.equal(normalizeLineEvent(undefined), null);
  });
});

describe("mediaDurationMs", () => {
  it("WAV：data 大小 / byteRate 為精確長度", () => {
    assert.equal(mediaDurationMs(wav(3)), 3000);
    assert.equal(mediaDurationMs(wav(2, 16000)), 2000);
  });

  it("MP4/M4A：moov→mvhd 的 timescale/duration", () => {
    assert.equal(mediaDurationMs(mp4WithMvhd(1000, 4500)), 4500);
    assert.equal(mediaDurationMs(mp4WithMvhd(44100, 44100 * 2)), 2000);
  });

  it("MP3：依首幀 bitrate 估計", () => {
    const buf = Buffer.alloc(32000);
    buf[0] = 0xff;
    buf[1] = 0xfb;
    buf[2] = 0x90; // bitrate index 9 = 128kbps (MPEG1 Layer III)
    buf[3] = 0x00;
    assert.equal(mediaDurationMs(buf), 2000);
  });

  it("認不出格式回 null", () => {
    assert.equal(mediaDurationMs(Buffer.alloc(100)), null);
    assert.equal(mediaDurationMs(Buffer.from("short")), null);
  });
});

describe("buildLineMessages", () => {
  const originalUploads = config.uploadsPath;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "line-official-"));
    config.uploadsPath = dir;
  });

  afterEach(() => {
    config.uploadsPath = originalUploads;
    rmSync(dir, { recursive: true, force: true });
  });

  it("文字超過 5000 字元自動分段", () => {
    const messages = buildLineMessages({ to: "U1", text: "字".repeat(12000) }, resolver);
    assert.ok(messages.length >= 3, `應切成 3 段以上，實際 ${messages.length}`);
    for (const m of messages) {
      assert.equal(m.type, "text");
      assert.ok((m.text ?? "").length <= 5000, `單段 ${m.text?.length} 字元超標`);
    }
  });

  it("圖片／影片：originalContentUrl 與 previewImageUrl 同為來源", () => {
    const [img] = buildLineMessages({ to: "U1", image: "https://cdn.example/a.png" }, resolver);
    assert.equal(img.type, "image");
    assert.equal(img.originalContentUrl, "https://cdn.example/a.png");
    assert.equal(img.previewImageUrl, img.originalContentUrl);
  });

  it("檔案：帶 fileName（優先使用者給的檔名）", () => {
    const [file] = buildLineMessages({ to: "U1", file: "report.pdf", filename: "年報.pdf" }, resolver);
    assert.equal(file.type, "file");
    assert.equal(file.fileName, "年報.pdf");
  });

  it("音訊：抓得到長度就用 audio（含 duration）", () => {
    writeFileSync(join(dir, "voice.wav"), wav(2));
    const [audio] = buildLineMessages({ to: "U1", audio: "voice.wav" }, resolver);
    assert.equal(audio.type, "audio");
    assert.equal(audio.duration, 2000);
  });

  it("音訊：抓不到長度（遠端 URL）降級成檔案", () => {
    const [msg] = buildLineMessages({ to: "U1", audio: "https://cdn.example/tts.mp3" }, resolver);
    assert.equal(msg.type, "file");
    assert.equal(msg.fileName, "tts.mp3");
  });

  it("貼圖／位置／Flex 原生轉成 LINE 訊息", () => {
    const [sticker] = buildLineMessages({ to: "U1", sticker: { packageId: "446", stickerId: "1988" } }, resolver);
    assert.deepEqual(sticker, { type: "sticker", packageId: "446", stickerId: "1988" });

    const [loc] = buildLineMessages(
      { to: "U1", location: { title: "台北101", address: "信義路", latitude: 25.033, longitude: 121.565 } },
      resolver,
    );
    assert.equal(loc.type, "location");
    assert.equal(loc.title, "台北101");
    assert.equal(loc.latitude, 25.033);

    const contents = { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } };
    const [flex] = buildLineMessages({ to: "U1", flex: { altText: "標題", contents } }, resolver);
    assert.equal(flex.type, "flex");
    assert.equal(flex.altText, "標題");
    assert.deepEqual(flex.contents, contents);
  });

  it("空輸入回空陣列（呼叫端跳過）", () => {
    assert.deepEqual(buildLineMessages({ to: "U1" }, resolver), []);
  });
});

describe("line 單一平台模式（仿 WhatsApp 擇一登入）", () => {
  const originalMode = config.line.mode;
  const originalSchedules = config.schedulesPath;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "line-mode-"));
    config.schedulesPath = join(dir, "schedules.json");
  });

  afterEach(() => {
    config.line.mode = originalMode;
    config.schedulesPath = originalSchedules;
    rmSync(dir, { recursive: true, force: true });
  });

  it("官方 adapter 也使用 platform = 'line'（不拆成第二個 channel）", () => {
    const svc = new LineOfficialService();
    try {
      assert.equal(svc.platform, "line");
      assert.equal(svc.loginStatus(), "未登入");
      assert.equal(svc.listTargets().length, 0);
    } finally {
      svc.stopQueue();
    }
  });

  it("personal 模式：LINE 能力全原生（無降級提示）", () => {
    config.line.mode = "personal";
    assert.deepEqual(degradedCapabilities("line"), []);
    assert.equal(capabilitiesFor("line")?.sticker.level, "native");
  });

  it("official 模式：音訊／貼圖降級，其餘維持原生", () => {
    config.line.mode = "official";
    const notes = degradedCapabilities("line");
    assert.ok(notes.some((n) => n.startsWith("audio")), notes.join(" | "));
    assert.ok(notes.some((n) => n.startsWith("sticker")), notes.join(" | "));
    const table = capabilitiesFor("line");
    assert.equal(table?.image.level, "native", "圖片仍是原生（只是需公開連結）");
    assert.equal(table?.sticker.level, "degraded");
    assert.equal(table?.flex.level, "native");
  });

  it("官方 adapter 在 personal 模式下不初始化", async () => {
    config.line.mode = "personal";
    const svc = new LineOfficialService();
    try {
      await svc.init();
      assert.equal(svc.loginStatus(), "未登入", "personal 模式不該連線");
      assert.equal(await svc.healthCheck(), false);
    } finally {
      svc.stopQueue();
    }
  });

  it("未知平台回 undefined", () => {
    assert.equal(capabilitiesFor("nope"), undefined);
    assert.deepEqual(degradedCapabilities("nope"), ["未知平台：nope"]);
  });
});
