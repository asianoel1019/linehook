import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLocationFromText } from "../src/messaging/location.js";

describe("extractLocationFromText（文字版位置）", () => {
  it("LINE 自帳號格式", () => {
    const loc = extractLocationFromText(
      "[ Location ]\nhttps://maps.google.com/maps?q=25.067264,121.597898&ll=25.067264,121.597898&z=16",
    );
    assert.deepEqual(loc, { latitude: 25.067264, longitude: 121.597898 });
  });

  it("Google 分享形與其他圖資", () => {
    assert.deepEqual(
      extractLocationFromText("https://www.google.com/maps/place/XXX/@25.06,121.59,16z"),
      { latitude: 25.06, longitude: 121.59 },
    );
    assert.deepEqual(
      extractLocationFromText("https://www.bing.com/maps?cp=25.06~121.59&lvl=15"),
      { latitude: 25.06, longitude: 121.59 },
    );
    assert.deepEqual(
      extractLocationFromText("https://www.openstreetmap.org/?mlat=25.06&mlon=121.59#map=15/25.06/121.59"),
      { latitude: 25.06, longitude: 121.59 },
    );
  });

  it("亂碼與空字串回 null", () => {
    assert.equal(extractLocationFromText(""), null);
    assert.equal(extractLocationFromText("今天天氣不錯"), null);
    assert.equal(extractLocationFromText("https://maps.google.com/maps?q=0,0"), null);
    assert.equal(extractLocationFromText("https://maps.google.com/maps?q=200,300"), null);
  });
});
