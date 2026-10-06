import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode, extractPrice, fmtPrice, pchomeParse, yahooParse } from "../src/skills/price-compare/index.js";

const YAHOO_HTML = `<div class="list">
<li class="GridItem"><div><a class="ProductTitle" href="https://tw.buy.yahoo.com/1">iPhone&nbsp;16 &amp; Watch</a><span>NT$32,900</span><a href="https://tw.buy.yahoo.com/p/1">看更多</a></div></li>
<li class="GridItem"><div><h3>Galaxy S25 Ultra</h3><em>28,900</em></div></li>
<li class="GridItem"><div><a class="ProductTitle">沒有價格的商品</a></div></li>
</div>`;

const PCHOME_HTML = `<ul>
<li class="prod_item"><a class="prod_name" title="iPhone 16 256G" href="/prod/abc123">x</a><b class="price">32900</b></li>
<li class="prod_item"><a class="prod_name" href="/prod/def456">Earbuds Pro</a><b class="price">4,990</b></li>
</ul>`;

describe("price-compare 解析", () => {
  it("extractPrice 取出數字，無效回 null", () => {
    assert.equal(extractPrice("NT$1,234"), 1234);
    assert.equal(extractPrice("32,900"), 32900);
    assert.equal(extractPrice("990"), 990);
    assert.equal(extractPrice("-"), null);
    assert.equal(extractPrice(""), null);
    assert.equal(extractPrice("0"), null, "0 不算有效價格");
  });

  it("decode 還原 HTML 實體並收斂空白", () => {
    assert.equal(decode("&lt;b&gt; &quot;c&amp;d&quot;&nbsp;"), `<b> "c&d"`);
    assert.equal(decode("A&amp;B"), "A&B");
    assert.equal(decode("  多個   空白  "), "多個 空白");
  });

  it("yahooParse：解析 GridItem 標題與價格、跳過沒有價格的項目", () => {
    const items = yahooParse(YAHOO_HTML, "https://tw.buy.yahoo.com/search/product?p=x");
    assert.equal(items.length, 2, "沒有價格的第三筆應被略過");
    assert.equal(items[0].source, "Yahoo購物");
    assert.equal(items[0].title, "iPhone 16 & Watch");
    assert.equal(items[0].price, 32900);
    assert.equal(items[0].url, "https://tw.buy.yahoo.com/1");
    assert.equal(items[1].title, "Galaxy S25 Ultra");
    assert.equal(items[1].price, 28900);
    assert.equal(items[1].url, "https://tw.buy.yahoo.com/search/product?p=x", "沒有連結時用搜尋頁當來源");
  });

  it("pchomeParse：解析 prod_item 標題、價格與站內連結", () => {
    const base = "https://24h.pchome.com.tw/search/?q=x";
    const items = pchomeParse(PCHOME_HTML, base);
    assert.equal(items.length, 2);
    assert.equal(items[0].source, "PChome 24h");
    assert.equal(items[0].title, "iPhone 16 256G");
    assert.equal(items[0].price, 32900);
    assert.equal(items[0].url, "https://24h.pchome.com.tw/prod/abc123");
    assert.equal(items[1].title, "Earbuds Pro");
    assert.equal(items[1].price, 4990);
    assert.equal(items[1].url, "https://24h.pchome.com.tw/prod/def456");
  });

  it("來源頁面結構對不上時回空陣列", () => {
    assert.deepEqual(yahooParse("<html><body>無資料</body></html>", "https://x"), []);
    assert.deepEqual(pchomeParse("<html><body>無資料</body></html>", "https://x"), []);
  });

  it("fmtPrice 依千分位格式化", () => {
    assert.equal(fmtPrice(0), "$0");
    assert.equal(fmtPrice(1234), "$1,234");
    assert.equal(fmtPrice(32900), "$32,900");
  });
});
