import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStations, type Station } from "../src/skills/hsr/index.js";

const st = (id: string, zh: string, en = ""): Station => ({ StationID: id, StationName: { Zh_tw: zh, En: en } });

// 照 TDX 由北到南擺（台北在左營前）：解析必須看文字位置，不能看清單順序
const stations: Station[] = [
  st("0990", "南港", "Nangang"),
  st("1000", "台北", "Taipei"),
  st("1030", "板橋", "Banqiao"),
  st("1050", "桃園", "Taoyuan"),
  st("1070", "台中", "Taichung"),
  st("1090", "嘉義", "Chiayi"),
  st("1110", "台南", "Tainan"),
  st("1120", "左營", "Zuoying"),
];

describe("高鐵起訖站解析", () => {
  it("左營到台北不反轉", () => {
    assert.deepEqual(parseStations("阿寶請幫忙 高鐵 左營 到 台北 明天 08:00", stations), {
      fromName: "左營",
      toName: "台北",
    });
  });

  it("台北到左營", () => {
    assert.deepEqual(parseStations("高鐵 台北 到 左營", stations), {
      fromName: "台北",
      toName: "左營",
    });
  });

  it("南→北中段（台中到板橋）", () => {
    assert.deepEqual(parseStations("高鐵 台中 到 板橋", stations), {
      fromName: "台中",
      toName: "板橋",
    });
  });

  it("無到字也按文字順序（左營 台北）", () => {
    assert.deepEqual(parseStations("高鐵 左營 台北", stations), {
      fromName: "左營",
      toName: "台北",
    });
  });
});
