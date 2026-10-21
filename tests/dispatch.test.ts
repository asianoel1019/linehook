import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { config } from "../src/config.js";
import { dispatchIncoming, type DispatchDeps } from "../src/messaging/dispatch.js";
import { loadSkills } from "../src/skills/loader.js";

await loadSkills();

function makeDeps(): DispatchDeps & { replies: string[]; enqueued: Array<{ to: string; text: string }> } {
  const replies: string[] = [];
  const enqueued: Array<{ to: string; text: string }> = [];
  const deps: DispatchDeps & { replies: string[]; enqueued: Array<{ to: string; text: string }> } = {
    replies,
    enqueued,
    platform: "test",
    replyTo: async (_chat, text) => { replies.push(text); },
    sendAdvanced: async () => {},
    sendMedia: async () => {},
    schedule: () => ({}) as never,
    scheduleSkillTask: () => ({}) as never,
    listSkillTasks: () => [],
    readTaskState: () => undefined,
    saveTaskState: () => true,
    cancelScheduledTask: () => true,
    enqueueText: async (to, text) => { enqueued.push({ to, text }); },
    getQueueStats: () => ({ pending: 0, running: false }),
    listScheduled: () => [],
  };
  return deps;
}

const saved = {
  assistant: { ...config.assistant },
  commands: { ...config.commands, allowFrom: [...config.commands.allowFrom] },
  forward: [...config.forward],
  skills: [...config.skills],
};

beforeEach(() => {
  config.assistant = { enabled: true, name: "阿寶" };
  config.commands = { enabled: true, prefix: "!", allowFrom: [] };
  config.forward = [];
  config.skills = [];
});

afterEach(() => {
  config.assistant = { ...saved.assistant };
  config.commands = { ...saved.commands, allowFrom: [...saved.commands.allowFrom] };
  config.forward = [...saved.forward];
  config.skills = [...saved.skills];
});

const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  chat: "c1",
  fromId: "u1",
  fromName: "tester",
  chatName: "",
  text,
  ...extra,
});

describe("dispatchIncoming", () => {
  it("空對話或空文字不做任何事", async () => {
    const d = makeDeps();
    await dispatchIncoming({ chat: "", fromId: "u", fromName: "", chatName: "", text: "hi" }, d);
    await dispatchIncoming(msg(""), d);
    assert.deepEqual(d.replies, []);
    assert.deepEqual(d.enqueued, []);
  });

  it("相同 messageId 只處理一次（去重）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "dup-1" }), d);
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "dup-1" }), d);
    assert.equal(d.replies.length, 1);
  });

  it("Layer 1：只喊助理名回技能清單", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    await dispatchIncoming(msg("阿寶請幫忙", { messageId: "l1-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /可用技能|沒有可用技能/);
  });

  it("指令 !id 回 chat 與 from", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("!id", { messageId: "cmd-1" }), d);
    assert.deepEqual(d.replies, ["chat=c1\nfrom=u1"]);
  });

  it("指令白名單擋陌生人", async () => {
    const d = makeDeps();
    config.commands.allowFrom = ["somebody-else"];
    await dispatchIncoming(msg("!id", { messageId: "cmd-2" }), d);
    assert.deepEqual(d.replies, []);
  });

  it("未知指令回提示", async () => {
    const d = makeDeps();
    await dispatchIncoming(msg("!nope", { messageId: "cmd-3" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /未知指令/);
  });

  it("轉發規則 match=all 轉發並帶前綴", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.forward = [{
      id: "r1", enabled: true, match: "all", keyword: "",
      source: "", target: "u9", includeSender: true, prefix: "[Fwd]",
    }];
    await dispatchIncoming(msg("hello world", { messageId: "fw-1", chatName: "群組" }), d);
    assert.deepEqual(d.enqueued, [{ to: "u9", text: "[Fwd] [群組] hello world" }]);
  });

  it("轉發規則 source 不符不轉發；非法 regex 不炸", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.forward = [{
      id: "r2", enabled: true, match: "regex", keyword: "([",
      source: "other-chat", target: "u9", includeSender: false, prefix: "",
    }];
    await dispatchIncoming(msg("hello", { messageId: "fw-2" }), d);
    assert.deepEqual(d.enqueued, []);
  });

  it("技能白名單擋陌生人（無需載入技能定義）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    config.skills = [{ id: "ghost", enabled: true, trigger: "x", allowedUsers: ["boss"], config: {} }];
    await dispatchIncoming(msg("anything", { messageId: "wl-1" }), d);
    assert.deepEqual(d.replies, []);
    assert.deepEqual(d.enqueued, []);
  });

  it("技能例外不會擊倒後續流程", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.assistant.enabled = false;
    // ghost 沒有定義會被跳過；重點是流程不丟例外
    config.skills = [{ id: "ghost", enabled: true, trigger: "x", allowedUsers: [], config: {} }];
    await dispatchIncoming(msg("anything", { messageId: "ex-1" }), d);
    assert.deepEqual(d.enqueued, []);
  });

  it("無前綴換算句直達匯率技能", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "exchange-rate", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "fx-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: "success",
          base_code: "USD",
          rates: { USD: 1, TWD: 32.5 },
          time_last_update_utc: "Thu, 16 Oct 2026 00:00:00 +0000",
        }),
      )) as typeof fetch;
    try {
      await dispatchIncoming(msg("100美金等於台幣", { messageId: "fx-e2e-1" }), d);
      assert.equal(d.replies.length, 1);
      assert.match(d.replies[0], /100 USD = 3250\.00 TWD/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("無前綴閒聊不觸發換算", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "exchange-rate", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    await dispatchIncoming(msg("我有100美金", { messageId: "fx-e2e-2" }), d);
    assert.deepEqual(d.replies, []);
  });

  it("有前綴時意圖路由用前綴後文字（助理名不污染參數）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "ybike", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } }];
    await dispatchIncoming(msg("阿寶請幫忙 YouBike ?", { messageId: "intent-prefix-1" }), d);
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /請指定站名/);
    assert.doesNotMatch(d.replies[0], /阿寶/);
  });

  it("有前綴換算句照樣直達", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "exchange-rate", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "fx-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: "success",
          base_code: "USD",
          rates: { USD: 1, TWD: 32.5 },
          time_last_update_utc: "Thu, 16 Oct 2026 00:00:00 +0000",
        }),
      )) as typeof fetch;
    try {
      await dispatchIncoming(msg("阿寶請幫忙 100美金等於台幣", { messageId: "fx-e2e-3" }), d);
      assert.equal(d.replies.length, 1);
      assert.match(d.replies[0], /100 USD = 3250\.00 TWD/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("優惠速覽聚合五家來源", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "deals", enabled: true, trigger: "", allowedUsers: [], config: {} }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "deals-e2e-"));
    const savedFetch = globalThis.fetch;
    const rss = (store: string, title: string) =>
      `<rss><channel><item><title>${title} - 某某新聞</title><link>https://news.test/1</link>` +
      `<pubDate>Thu, 16 Oct 2026 00:00:00 +0800</pubDate><source>某某新聞</source></item></channel></rss>`;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("info.talk.tw")) {
        return new Response(
          `<table><tr><th>餐點品項</th><th>優惠內容</th></tr>` +
            `<tr><td>大薯買一送一</td><td>$99元 即日起至10/31</td></tr></table>`,
        );
      }
      if (url.includes("burgerking") || url.includes("mos.com.tw")) {
        return new Response(`<div>華堡限時 $129 起，數量有限</div>`);
      }
      if (url.includes("starbucks.user.today")) {
        return new Response(
          `<div class="date-num">10/16</div>` +
            `<a href="https://sbux.test/1" data-type="買一送一" data-type2="飲料" title="拿鐵買一送一">詳情</a>`,
        );
      }
      if (url.includes("winedays.github.io")) {
        return new Response(
          JSON.stringify({ coupon_by_code: { 15730: { coupon_code: 15730, name: "肯德基-大餐", price: 99 } } }),
        );
      }
      if (url.includes("news.google.com")) {
        return new Response(rss("store", url.includes("%E5%85%A8") ? "全聯買一送一開跑" : "家樂福衛生紙特價"));
      }
      if (url.includes("uni-prosperity")) return new Response("[]");
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;
    try {
      await dispatchIncoming(msg("阿寶請幫忙 優惠", { messageId: "deals-e2e-1" }), d);
      assert.equal(d.replies.length, 1);
      for (const brand of ["麥當勞", "肯德基", "漢堡王", "星巴克", "全聯", "家樂福"]) {
        assert.ok(d.replies[0].includes(`【${brand}】`), `缺 ${brand}`);
      }
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("位置訊息直送 handlesLocation 技能", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "ybike", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "loc-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      if (url.includes("Station/NearBy")) {
        return new Response(JSON.stringify([
          { StationUID: "u1", StationID: "1", StationName: { Zh_tw: "近站" }, StationAddress: { Zh_tw: "近路" }, StationPosition: { PositionLat: 25.048, PositionLon: 121.5172 }, BikesCapacity: 20 },
        ]));
      }
      return new Response(JSON.stringify([
        { StationUID: "u1", StationID: "1", ServiceStatus: 1, AvailableRentBikes: 4, AvailableReturnBikes: 4 },
      ]));
    }) as typeof fetch;
    try {
      await dispatchIncoming(
        msg("", { messageId: "loc-e2e-1", location: { latitude: 25.0478, longitude: 121.517 } }),
        d,
      );
      assert.equal(d.replies.length, 1);
      assert.match(d.replies[0], /附近的 YouBike/);
      assert.match(d.replies[0], /近站/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("無技能處理位置時給提示（不炸）", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "ybike", enabled: false, trigger: "", allowedUsers: [], config: {} }];
    await dispatchIncoming(
      msg("", { messageId: "loc-e2e-2", location: { latitude: 25.0478, longitude: 121.517 } }),
      d,
    );
    assert.equal(d.replies.length, 1);
    assert.match(d.replies[0], /沒有可查詢附近的技能/);
  });

  it("位置訊息 fan-out：ybike＋bus 各回一則", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [
      { id: "ybike", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } },
      { id: "bus", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } },
    ];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "loc-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      if (url.includes("Bike/Station/NearBy")) {
        return new Response(JSON.stringify([
          { StationUID: "u1", StationID: "1", StationName: { Zh_tw: "近站" }, StationAddress: { Zh_tw: "近路" }, StationPosition: { PositionLat: 25.048, PositionLon: 121.5172 }, BikesCapacity: 20 },
        ]));
      }
      if (url.includes("Bike/Availability/NearBy")) {
        return new Response(JSON.stringify([
          { StationUID: "u1", StationID: "1", ServiceStatus: 1, AvailableRentBikes: 4, AvailableReturnBikes: 4 },
        ]));
      }
      if (url.includes("Bus/Stop/City/")) {
        return new Response(JSON.stringify([
          { StopUID: "s1", StopID: "1", StopName: { Zh_tw: "附近站牌" }, StopAddress: "台北市某路", StopPosition: { PositionLon: 121.5172, PositionLat: 25.048 } },
        ]));
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;
    try {
      await dispatchIncoming(
        msg("", { messageId: "loc-e2e-4", location: { latitude: 25.0478, longitude: 121.517 } }),
        d,
      );
      assert.equal(d.replies.length, 2);
      assert.match(d.replies[0], /附近的 YouBike/);
      assert.match(d.replies[1], /附近的公車站牌/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("文字版位置（地圖連結）也直送附近查詢", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "ybike", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "loc-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      if (url.includes("Station/NearBy")) {
        return new Response(JSON.stringify([
          { StationUID: "u1", StationID: "1", StationName: { Zh_tw: "近站" }, StationAddress: { Zh_tw: "近路" }, StationPosition: { PositionLat: 25.067, PositionLon: 121.598 }, BikesCapacity: 20 },
        ]));
      }
      return new Response(JSON.stringify([
        { StationUID: "u1", StationID: "1", ServiceStatus: 1, AvailableRentBikes: 4, AvailableReturnBikes: 4 },
      ]));
    }) as typeof fetch;
    try {
      await dispatchIncoming(
        msg("[ Location ]\nhttps://maps.google.com/maps?q=25.067264,121.597898&ll=25.067264,121.597898&z=16", { messageId: "loc-e2e-3" }),
        d,
      );
      assert.equal(d.replies.length, 1);
      assert.match(d.replies[0], /附近的 YouBike/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });

  it("班號問句直送航班動態", async () => {
    const d = makeDeps();
    config.commands.enabled = false;
    config.skills = [{ id: "flight-status", enabled: true, trigger: "", allowedUsers: [], config: { tdxClientId: "id", tdxClientSecret: "sec" } }];
    const savedCache = config.cachePath;
    config.cachePath = mkdtempSync(join(tmpdir(), "flight-e2e-"));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      if (url.includes("/Departure")) {
        return new Response(JSON.stringify([]));
      }
      return new Response(JSON.stringify([
        {
          FlightDate: "2026-10-21", FlightNumber: "100", AirlineID: "CI",
          DepartureAirportID: "HKG", ArrivalAirportID: "TPE",
          ScheduleArrivalTime: "2026-10-21T15:30", EstimatedArrivalTime: "2026-10-21T16:05",
          ArrivalRemark: "延誤DELAYED", Terminal: "2", Gate: "D4",
        },
      ]));
    }) as typeof fetch;
    try {
      await dispatchIncoming(msg("CI100到了沒", { messageId: "flight-e2e-1" }), d);
      assert.equal(d.replies.length, 1);
      assert.match(d.replies[0], /CI100/);
      assert.match(d.replies[0], /延誤/);
    } finally {
      globalThis.fetch = savedFetch;
      config.cachePath = savedCache;
    }
  });
});
