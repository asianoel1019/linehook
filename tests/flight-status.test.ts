import { describe, it } from "node:test";
import assert from "node:assert/strict";
import flightStatusSkill, {
  parseFlightNo,
  parseFlightIntent,
  parseDirection,
  toStatus,
  statusSummary,
  statusSignature,
  formatFlight,
  parseFlightDate,
  parseTrip,
  shouldPoll,
  isTripOver,
  todayYmd,
  normAirline,
  matchAirline,
  lookupFlight,
} from "../src/skills/flight-status/index.js";
import type { SkillContext } from "../src/skills/types.js";

const ARR = {
  FlightDate: "2026-10-21",
  FlightNumber: "100",
  AirlineID: "CI",
  DepartureAirportID: "HKG",
  ArrivalAirportID: "TPE",
  ScheduleArrivalTime: "2026-10-21T15:30",
  EstimatedArrivalTime: "2026-10-21T16:05",
  ArrivalRemark: "延誤DELAYED",
  Terminal: "2",
  Gate: "D4",
  IsCargo: false,
  BaggageClaim: "01",
  UpdateTime: "2026-10-21T14:00:00+08:00",
};

function tdxStub() {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("openid-connect/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    if (url.includes("/Departure")) {
      return new Response(JSON.stringify([]));
    }
    if (url.includes("999")) {
      return new Response(JSON.stringify([]));
    }
    return new Response(JSON.stringify([ARR]));
  }) as typeof fetch;
}

function runCtx(overrides: Partial<SkillContext> = {}, store: { state?: Record<string, unknown> } = {}) {
  const replies: string[] = [];
  const ctx = {
    text: "",
    args: "",
    fromName: "t",
    chat: "c",
    fromMid: "u",
    config: { tdxClientId: "id", tdxClientSecret: "sec" },
    reply: async (t: string) => {
      replies.push(t);
    },
    sendImage: async () => {},
    sendFile: async () => {},
    schedule: () => "s",
    watch: () => "w1",
    unwatch: () => true,
    watches: () => [],
    taskState: () => store.state,
    ...overrides,
  } as unknown as SkillContext;
  return { ctx, replies, store };
}

describe("flight-status parseFlightNo", () => {
  it("代碼與中文航空名", () => {
    assert.deepEqual(parseFlightNo("航班 CI100"), { airline: "CI", number: "100" });
    assert.deepEqual(parseFlightNo("CI 100"), { airline: "CI", number: "100" });
    assert.deepEqual(parseFlightNo("BR-1234"), { airline: "BR", number: "1234" });
    assert.deepEqual(parseFlightNo("長榮100"), { airline: "BR", number: "100" });
    assert.deepEqual(parseFlightNo("虎航 IT200"), { airline: "IT", number: "200" });
  });

  it("無班號回 null", () => {
    assert.equal(parseFlightNo("亂七八糟"), null);
    assert.equal(parseFlightNo("航班"), null);
  });
});

describe("flight-status parseFlightIntent / parseDirection", () => {
  it("班號＋情境才命中", () => {
    assert.deepEqual(parseFlightIntent("CI100到了沒"), { airline: "CI", number: "100" });
    assert.equal(parseFlightIntent("CI100"), null);
    assert.equal(parseFlightIntent("今天天氣不錯"), null);
  });

  it("出境入境判斷", () => {
    assert.equal(parseDirection("CI100 出境"), "dep");
    assert.equal(parseDirection("CI100 降落了沒"), "arr");
    assert.equal(parseDirection("CI100"), "both");
  });
});

describe("flight-status 狀態與格式", () => {
  it("toStatus 取對應方向欄位", () => {
    const s = toStatus(ARR, "arr");
    assert.equal(s.scheduled, "2026-10-21T15:30");
    assert.equal(s.estimated, "2026-10-21T16:05");
    assert.equal(s.gate, "D4");
  });

  it("statusSummary：取消／延誤分／準時", () => {
    assert.equal(statusSummary(toStatus(ARR, "arr")), "延誤35分");
    assert.equal(statusSummary({ ...toStatus(ARR, "arr"), remark: "取消CANCELLED" }), "取消");
    assert.equal(
      statusSummary({ ...toStatus(ARR, "arr"), estimated: "2026-10-21T15:30", remark: "" }),
      "準時",
    );
  });

  it("statusSignature 變動偵測", () => {
    const a = toStatus(ARR, "arr");
    const b = toStatus({ ...ARR, Gate: "C1" }, "arr");
    assert.notEqual(statusSignature(a), statusSignature(b));
    assert.equal(statusSignature(a), statusSignature(toStatus(ARR, "arr")));
  });

  it("formatFlight 形狀", () => {
    const s = formatFlight(toStatus(ARR, "arr"));
    assert.ok(s.includes("CI100（入境"));
    assert.ok(s.includes("香港 → 桃園"));
    assert.ok(s.includes("延誤35分"));
    assert.ok(s.includes("登機門 D4"));
  });
});

describe("flight-status run()", () => {
  const savedFetch = globalThis.fetch;

  it("班號查詢回動態", async () => {
    globalThis.fetch = tdxStub();
    try {
      const { ctx, replies } = runCtx({ args: "CI100" });
      await flightStatusSkill.run(ctx);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /CI100/);
      assert.match(replies[0], /延誤35分/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("無班號給用法；查無給提示", async () => {
    globalThis.fetch = tdxStub();
    try {
      const r1 = runCtx({ args: "亂講話" });
      await flightStatusSkill.run(r1.ctx);
      assert.match(r1.replies[0], /請指定班號/);
      const r2 = runCtx({ args: "CI999" });
      await flightStatusSkill.run(r2.ctx);
      assert.match(r2.replies[0], /查不到 CI999/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("訂閱 → 清單 → 取消", async () => {
    globalThis.fetch = tdxStub();
    try {
      const store: { state?: Record<string, unknown> } = {};
      const sub = runCtx({ args: "訂閱 CI100" }, store);
      (sub.ctx as { watch: (o: unknown) => string }).watch = ((o: { state?: Record<string, unknown> }) => {
        store.state = o.state;
        return "w1";
      }) as never;
      await flightStatusSkill.run(sub.ctx);
      assert.match(sub.replies[0], /已訂閱 CI100/);
      assert.equal((store.state as { subs: unknown[] }).subs.length, 1);

      const list = runCtx({ args: "清單" }, store);
      await flightStatusSkill.run(list.ctx);
      assert.match(list.replies[0], /CI100/);

      const cancel = runCtx({ args: "取消 CI100" }, store);
      await flightStatusSkill.run(cancel.ctx);
      assert.match(cancel.replies[0], /已取消：CI100/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("flight-status onTask", () => {
  const savedFetch = globalThis.fetch;

  it("簽章變了才推播；相同不擾", async () => {
    const remark = "準時ON TIME";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify([{ ...ARR, ArrivalRemark: remark, EstimatedArrivalTime: "2026-10-21T15:30" }]));
    }) as typeof fetch;
    try {
      let saved: Record<string, unknown> | undefined;
      const replies: string[] = [];
      const base = {
        taskId: "t",
        task: "flight-watch",
        chat: "c",
        fromName: "n",
        config: { tdxClientId: "id", tdxClientSecret: "sec" },
        args: {},
        saveState: async (patch: Record<string, unknown>) => {
          saved = patch;
        },
        reply: async (t: string) => {
          replies.push(t);
        },
        sendImage: async () => {},
        sendFile: async () => {},
      } as never;
      await flightStatusSkill.onTask!({
        ...base,
        state: { subs: [{ airline: "CI", number: "100", direction: "both", label: "CI100", lastSig: "OLD", done: false }] },
      });
      assert.equal(replies.length, 1);
      assert.match(replies[0], /CI100 異動/);
      const sig = (saved as { subs: Array<{ lastSig: string }> }).subs[0].lastSig;
      assert.notEqual(sig, "OLD");

      // 第二輪相同簽章不再推
      replies.length = 0;
      saved = undefined;
      await flightStatusSkill.onTask!({
        ...base,
        state: { subs: [{ airline: "CI", number: "100", direction: "both", label: "CI100", lastSig: sig, done: false }] },
      });
      assert.deepEqual(replies, []);
      assert.equal(saved, undefined);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("flight-status 旅程日期", () => {
  const TODAY = "2026-10-20";

  it("parseFlightDate：M/D、中月日、跨年", () => {
    assert.deepEqual(parseFlightDate("11/18", TODAY), { ymd: "2026-11-18", matched: "11/18" });
    assert.deepEqual(parseFlightDate("11月18日", TODAY), { ymd: "2026-11-18", matched: "11月18日" });
    assert.deepEqual(parseFlightDate("1/5", TODAY)?.ymd, "2027-01-05");
    assert.equal(parseFlightDate("亂講話", TODAY), null);
    assert.equal(parseFlightDate("13/45", TODAY), null);
  });

  it("parseTrip：使用者原句配對＋行程名", () => {
    const r = parseTrip("行程 11/18 JX715 11/24 JX716 東京行", TODAY);
    assert.equal(r.legs.length, 2);
    assert.deepEqual(r.legs[0], { flight: { airline: "JX", number: "715" }, date: "2026-11-18" });
    assert.deepEqual(r.legs[1], { flight: { airline: "JX", number: "716" }, date: "2026-11-24" });
    assert.equal(r.name, "東京行");
  });

  it("parseTrip：先班號後日期也配對", () => {
    const r = parseTrip("行程 JX715 11/18", TODAY);
    assert.equal(r.legs.length, 1);
    assert.deepEqual(r.legs[0], { flight: { airline: "JX", number: "715" }, date: "2026-11-18" });
    assert.equal(r.name, "");
  });

  it("shouldPoll／isTripOver 窗口", () => {
    assert.equal(shouldPoll({}, TODAY), true);
    assert.equal(shouldPoll({ date: "2026-11-18" }, TODAY), false);
    assert.equal(shouldPoll({ date: "2026-10-20" }, TODAY), true);
    assert.equal(shouldPoll({ date: "2026-10-19" }, TODAY), true);
    assert.equal(shouldPoll({ date: "2026-10-21" }, TODAY), true);
    assert.equal(shouldPoll({ date: "2026-10-18" }, TODAY), false);
    assert.equal(isTripOver({ date: "2026-10-18" }, TODAY), true);
    assert.equal(isTripOver({ date: "2026-10-19" }, TODAY), false);
    assert.equal(isTripOver({}, TODAY), false);
  });

  it("todayYmd 格式", () => {
    assert.match(todayYmd(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("run() 行程：一次建兩段＋共享 tripId", async () => {
    const replies: string[] = [];
    let state: Record<string, unknown> | undefined;
    await flightStatusSkill.run({
      text: "航班 行程 11/18 JX715 11/24 JX716 東京行",
      args: "行程 11/18 JX715 11/24 JX716 東京行",
      fromName: "t",
      chat: "c",
      fromMid: "u",
      config: { tdxClientId: "id", tdxClientSecret: "sec" },
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "s",
      watch: (o: { state?: Record<string, unknown> }) => {
        state = o.state;
        return "w1";
      },
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    } as never);
    // 行程建立不打網路（等窗口才查）
    assert.equal(replies.length, 1);
    assert.match(replies[0], /已建立行程「東京行」/);
    assert.match(replies[0], /JX715/);
    assert.match(replies[0], /JX716/);
    const subs = (state as { subs: Array<{ tripId: string; date: string; label: string }> }).subs;
    assert.equal(subs.length, 2);
    assert.equal(subs[0].tripId, subs[1].tripId);
  });

  it("run() 未來單段訂閱：不驗證、等窗口", async () => {
    const replies: string[] = [];
    let state: Record<string, unknown> | undefined;
    const future = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const md = `${Number(future.slice(5, 7))}/${Number(future.slice(8, 10))}`;
    await flightStatusSkill.run({
      text: "",
      args: `訂閱 JX715 ${md}`,
      fromName: "t",
      chat: "c",
      fromMid: "u",
      config: { tdxClientId: "id", tdxClientSecret: "sec" },
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
      schedule: () => "s",
      watch: (o: { state?: Record<string, unknown> }) => {
        state = o.state;
        return "w1";
      },
      unwatch: () => true,
      watches: () => [],
      taskState: () => undefined,
    } as never);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /前一天開始追蹤/);
    const subs = (state as { subs: Array<{ lastSig: string; date: string }> }).subs;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].lastSig, "");
  });

  it("run() 清單行程成團＋取消行程", async () => {
    const store: { state?: Record<string, unknown> } = {
      state: {
        subs: [
          { airline: "JX", number: "715", direction: "both", label: "JX715", lastSig: "", done: false, date: "2026-11-18", tripId: "t1", tripLabel: "東京行" },
          { airline: "JX", number: "716", direction: "both", label: "JX716", lastSig: "", done: false, date: "2026-11-24", tripId: "t1", tripLabel: "東京行" },
          { airline: "CI", number: "100", direction: "both", label: "CI100", lastSig: "x", done: false },
        ],
      },
    };
    const mkCtx = (args: string, replies: string[]) =>
      ({
        text: "",
        args,
        fromName: "t",
        chat: "c",
        fromMid: "u",
        config: { tdxClientId: "id", tdxClientSecret: "sec" },
        reply: async (t: string) => {
          replies.push(t);
        },
        sendImage: async () => {},
        sendFile: async () => {},
        schedule: () => "s",
        watch: (o: { state?: Record<string, unknown> }) => {
          store.state = o.state;
          return "w1";
        },
        unwatch: () => true,
        watches: () => [],
        taskState: () => store.state,
      }) as never;
    const r1: string[] = [];
    await flightStatusSkill.run(mkCtx("清單", r1));
    assert.match(r1[0], /🧳 東京行/);
    assert.match(r1[0], /JX715/);
    assert.match(r1[0], /CI100/);

    const r2: string[] = [];
    await flightStatusSkill.run(mkCtx("取消行程 東京", r2));
    assert.match(r2[0], /已取消行程：東京行（2 段）/);
    const subs = (store.state as { subs: unknown[] }).subs;
    assert.equal(subs.length, 1);
  });

  it("onTask：太早跳過不打擾；過期靜默結案", async () => {
    const future = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const replies: string[] = [];
    let saved: Record<string, unknown> | undefined;
    await flightStatusSkill.onTask!({
      taskId: "t",
      task: "flight-watch",
      chat: "c",
      fromName: "n",
      config: {},
      args: {},
      state: {
        subs: [
          { airline: "JX", number: "715", direction: "both", label: "JX715", lastSig: "", done: false, date: future },
          { airline: "JX", number: "716", direction: "both", label: "JX716", lastSig: "x", done: false, date: past },
        ],
      },
      saveState: async (patch: Record<string, unknown>) => {
        saved = patch;
      },
      reply: async (t: string) => {
        replies.push(t);
      },
      sendImage: async () => {},
      sendFile: async () => {},
    } as never);
    // 未打 TDX（太早），無推播；過期那段結案存檔
    assert.deepEqual(replies, []);
    const subs = (saved as { subs: Array<{ done: boolean; label: string }> }).subs;
    assert.equal(subs.find((s) => s.label === "JX716")?.done, true);
    assert.equal(subs.find((s) => s.label === "JX715")?.done, false);
  });
});

describe("flight-status 同號他航", () => {
  const savedFetch = globalThis.fetch;
  const otherAirline = { ...ARR, AirlineID: "BR", FlightNumber: "100" };

  it("normAirline 去空白轉大寫", () => {
    assert.equal(normAirline(" jx "), "JX");
    assert.equal(normAirline(undefined), "");
  });

  it("matchAirline IATA/ICAO 互通", () => {
    assert.equal(matchAirline("JX", "JX"), true);
    assert.equal(matchAirline("SJX", "JX"), true);
    assert.equal(matchAirline("CAL", "CI"), true);
    assert.equal(matchAirline("BR", "JX"), false);
    assert.equal(matchAirline(undefined, "JX"), false);
  });

  it("ICAO 代碼也算命中（SJX→JX）", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify([{ ...ARR, AirlineID: "SJX", FlightNumber: "715" }]));
    }) as typeof fetch;
    try {
      const found = await lookupFlight("JX", "715", "arr", "tok");
      assert.equal(found.exact, true);
      assert.equal(found.rows[0].airline, "SJX");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("lookupFlight 優先指定航空並標 exact", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify([ARR, otherAirline]));
    }) as typeof fetch;
    try {
      const found = await lookupFlight("CI", "100", "arr", "tok");
      assert.equal(found.exact, true);
      assert.ok(found.rows.length > 0);
      assert.ok(found.rows.every((r) => r.airline === "CI"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("查無指定航空時標示他航（不裝作命中）", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify([otherAirline]));
    }) as typeof fetch;
    try {
      const found = await lookupFlight("CI", "100", "arr", "tok");
      assert.equal(found.exact, false);
      assert.equal(found.rows[0].airline, "BR");

      const replies: string[] = [];
      await flightStatusSkill.run({
        text: "航班 JX715",
        args: "JX715",
        fromName: "t",
        chat: "c",
        fromMid: "u",
        config: { tdxClientId: "id", tdxClientSecret: "sec" },
        reply: async (t: string) => {
          replies.push(t);
        },
        sendImage: async () => {},
        sendFile: async () => {},
        schedule: () => "s",
        watch: () => "w",
        unwatch: () => true,
        watches: () => [],
        taskState: () => undefined,
      } as never);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /查無 JX715，今日同號其他航空/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("訂閱遇到他航不建檔", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      return new Response(JSON.stringify([otherAirline]));
    }) as typeof fetch;
    const store: { state?: Record<string, unknown> } = {};
    const replies: string[] = [];
    try {
      await flightStatusSkill.run({
        text: "",
        args: "訂閱 JX715",
        fromName: "t",
        chat: "c",
        fromMid: "u",
        config: { tdxClientId: "id", tdxClientSecret: "sec" },
        reply: async (t: string) => {
          replies.push(t);
        },
        sendImage: async () => {},
        sendFile: async () => {},
        schedule: () => "s",
        watch: (o: { state?: Record<string, unknown> }) => {
          store.state = o.state;
          return "w1";
        },
        unwatch: () => true,
        watches: () => [],
        taskState: () => undefined,
      } as never);
      assert.match(replies[0], /查無 JX715/);
      assert.equal(store.state, undefined);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
