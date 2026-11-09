import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStations, type Station } from "../src/skills/train/index.js";

const st = (id: string, zh: string, en = ""): Station => ({ StationID: id, StationName: { Zh_tw: zh, En: en } });

// 刻意照 TDX 由北到南擺（南港在浮洲前）：解析必須看文字位置，不能看清單順序
const stations: Station[] = [
  st("0990", "南港", "Nangang"),
  st("1000", "臺北", "Taipei"),
  st("1060", "浮洲", "Fuzhou"),
  st("4340", "新左營", "Xinzuoying"),
  st("4350", "左營", "Zuoying"),
  st("4400", "高雄", "Kaohsiung"),
];

describe("火車起訖站解析", () => {
  it("浮洲到南港不反轉（回報的 bug）", () => {
    assert.deepEqual(parseStations("阿寶請幫忙 火車 浮洲 到 南港", stations), {
      fromName: "浮洲",
      toName: "南港",
    });
  });

  it("南港到浮洲", () => {
    assert.deepEqual(parseStations("火車 南港 到 浮洲", stations), {
      fromName: "南港",
      toName: "浮洲",
    });
  });

  it("無到字也按文字順序（浮洲 南港）", () => {
    assert.deepEqual(parseStations("火車 浮洲 南港", stations), {
      fromName: "浮洲",
      toName: "南港",
    });
  });

  it("台北（台）對得上臺北站名", () => {
    assert.deepEqual(parseStations("火車 台北 到 高雄", stations), {
      fromName: "臺北",
      toName: "高雄",
    });
  });

  it("新左營不被左營吃掉（同位置取最長）", () => {
    assert.deepEqual(parseStations("火車 新左營 到 高雄", stations), {
      fromName: "新左營",
      toName: "高雄",
    });
  });

  it("站名加站字（南港站）", () => {
    assert.deepEqual(parseStations("火車 浮洲站 到 南港站", stations), {
      fromName: "浮洲",
      toName: "南港",
    });
  });
});
