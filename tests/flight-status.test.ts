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
