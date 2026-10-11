import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatEntry, parseEntry } from "../src/skills/dict/index.js";
import { formatWiki, langOf, queryOf } from "../src/skills/wiki/index.js";

describe("dict parseEntry", () => {
  it("解析多音字與多義項", () => {
    const senses = parseEntry({
      title: "台",
      heteronyms: [
        {
          bopomofo: "ㄊㄞ",
          pinyin: "tāi",
          definitions: [
            { def: "地名用字。大陸地區浙江省台州、天台山。", type: "名" },
            { def: "喜悅。", type: "形", quote: ["《史記》：『台』"] },
          ],
        },
        {
          bopomofo: "ㄊㄞˊ",
          definitions: [{ def: "我。古人自稱。", type: "代" }],
        },
      ],
    });
    assert.equal(senses.length, 3);
    assert.equal(senses[0].bopomofo, "ㄊㄞ");
    assert.equal(senses[0].pinyin, "tāi");
    assert.equal(senses[1].type, "形");
    assert.equal(senses[1].quotes[0].includes("史記"), true);
    assert.equal(senses[2].bopomofo, "ㄊㄞˊ");
  });

  it("空/怪結構回空陣列", () => {
    assert.deepEqual(parseEntry({}), []);
    assert.deepEqual(parseEntry({ heteronyms: "nope" }), []);
    assert.deepEqual(parseEntry({ heteronyms: [{ definitions: [{ def: "" }] }] }), []);
    assert.deepEqual(parseEntry(null), []);
  });
});

describe("dict formatEntry", () => {
  it("查無時給提示", () => {
    assert.match(formatEntry("白爛", []), /查無「白爛」/);
  });

  it("有義項時列出定義與例句", () => {
    const text = formatEntry("朝三暮四", [
      { bopomofo: "ㄓㄠ", pinyin: "zhāo", type: "副", def: "早上。", quotes: [] },
      { bopomofo: "ㄓㄠ", pinyin: "zhāo", type: "名", def: "早晨。", quotes: ["例：朝令夕改。"] },
    ]);
    assert.match(text, /朝三暮四（注音 ㄓㄠ／拼音 zhāo）/);
    assert.match(text, /1\. 〔副〕早上。/);
    assert.match(text, /2\. 〔名〕早晨。/);
    assert.match(text, /例：朝令夕改。/);
    assert.match(text, /教育部國語辭典/);
  });
});

describe("wiki langOf / queryOf", () => {
  it("語言關鍵字", () => {
    assert.equal(langOf("英文 black hole", {}), "en");
    assert.equal(langOf("english black hole", {}), "en");
    assert.equal(langOf("日文 富士山", {}), "ja");
    assert.equal(langOf("台灣", {}), "zh");
    assert.equal(langOf("台灣", { lang: "ja" }), "ja");
    assert.equal(langOf("台灣", { lang: "德文" }), "zh");
  });

  it("取出查詢詞", () => {
    assert.equal(queryOf("請幫忙 維基 台灣"), "台灣");
    assert.equal(queryOf("英文 black hole"), "black hole");
    assert.equal(queryOf("維基 查一下 富士山"), "富士山");
  });
});

describe("wiki formatWiki", () => {
  const base = {
    lang: "zh",
    title: "臺灣",
    description: "東亞島嶼",
    extract: "臺灣是位於東亞的島嶼。",
    url: "https://zh.wikipedia.org/wiki/臺灣",
    thumbnail: "",
  };

  it("完整輸出標題、摘要與連結", () => {
    const text = formatWiki(base);
    assert.match(text, /📖 臺灣（東亞島嶼）/);
    assert.match(text, /臺灣是位於東亞的島嶼。/);
    assert.match(text, /zh\.wikipedia\.org/);
  });

  it("過長摘要在標點處截斷", () => {
    const long = `${base.extract}${"啊".repeat(600)}。尾巴`;
    const text = formatWiki({ ...base, extract: long }, 50);
    assert.ok(text.includes("…"));
    assert.ok(text.length < 200);
  });

  it("沒有 description 不顯示括號", () => {
    const text = formatWiki({ ...base, description: "" });
    assert.doesNotMatch(text, /臺灣（/);
  });
});
