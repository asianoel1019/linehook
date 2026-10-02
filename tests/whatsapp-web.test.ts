import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toWaJid, extractWaText } from "../src/whatsapp/web-client.js";

describe("toWaJid", () => {
  it("電話號碼轉 JID", () => {
    assert.equal(toWaJid("886912345678"), "886912345678@s.whatsapp.net");
  });

  it("含 + / 分隔符會清掉", () => {
    assert.equal(toWaJid("+886-912-345-678"), "886912345678@s.whatsapp.net");
  });

  it("已含 @ 則原樣保留（群組 / lid）", () => {
    assert.equal(toWaJid("123456789-987654@g.us"), "123456789-987654@g.us");
    assert.equal(toWaJid("12345@lid"), "12345@lid");
  });
});

describe("extractWaText", () => {
  it("conversation", () => {
    assert.equal(extractWaText({ conversation: " 你好 " }), "你好");
  });

  it("extendedTextMessage", () => {
    assert.equal(extractWaText({ extendedTextMessage: { text: "hi" } }), "hi");
  });

  it("圖片 caption", () => {
    assert.equal(extractWaText({ imageMessage: { caption: "看這個" } }), "看這個");
  });

  it("按鈕回覆", () => {
    assert.equal(extractWaText({ buttonsResponseMessage: { selectedDisplayText: "確認" } }), "確認");
  });

  it("清單回覆", () => {
    assert.equal(extractWaText({ listResponseMessage: { title: "選項一" } }), "選項一");
  });

  it("無文字回空字串", () => {
    assert.equal(extractWaText({ imageMessage: {} }), "");
    assert.equal(extractWaText(null), "");
    assert.equal(extractWaText({}), "");
  });
});
