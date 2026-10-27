import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchJson, getOutboundStats, isHostDegraded, recordOutbound, resetOutboundStats } from "../src/net.js";
import { getCounters } from "../src/metrics.js";

let base = "";
let server: Server;

before(async () => {
  resetOutboundStats();
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(500);
      res.end();
    }).listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

after(async () => {
  resetOutboundStats();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("P0-3 對外呼叫統計", () => {
  it("fetchJson 成功/失敗都記數（host 維度）", async () => {
    resetOutboundStats();
    await fetchJson(`${base}/ok`);
    await assert.rejects(fetchJson(`${base}/boom`), /HTTP 500/);
    const row = getOutboundStats().find((s) => s.host === "127.0.0.1");
    assert.ok(row);
    assert.equal(row.calls, 2);
    assert.equal(row.fails, 1);
    assert.equal(row.consecFails, 1);
    assert.ok(typeof row.lastOkAt === "number");
    assert.ok(typeof row.lastFailAt === "number");
    const counter = getCounters().find(
      (c) => c.name === "outbound_calls_total" && c.labels.host === "127.0.0.1" && c.labels.result === "fail",
    );
    assert.equal(counter?.value, 1);
  });

  it("成功重置連敗", async () => {
    resetOutboundStats();
    recordOutbound("https://example.com/a", false);
    recordOutbound("https://example.com/a", false);
    await fetchJson(`${base}/ok`).catch(() => {});
    recordOutbound("https://example.com/a", true);
    const row = getOutboundStats().find((s) => s.host === "example.com");
    assert.equal(row?.consecFails, 0);
    assert.equal(row?.calls, 3);
  });

  it("連敗 5 次進降級；冷卻後放行", () => {
    resetOutboundStats();
    for (let i = 0; i < 4; i++) recordOutbound("https://tdx.example.com/x", false);
    assert.equal(isHostDegraded("tdx.example.com"), false);
    recordOutbound("https://tdx.example.com/x", false);
    assert.equal(isHostDegraded("tdx.example.com"), true);
    assert.equal(isHostDegraded("https://tdx.example.com/x"), true);
    assert.equal(isHostDegraded("other.example.com"), false);
  });

  it("無效 URL 記到 invalid 不炸", () => {
    resetOutboundStats();
    recordOutbound("not a url", false);
    assert.equal(getOutboundStats().find((s) => s.host === "invalid")?.calls, 1);
    assert.equal(isHostDegraded("not a url"), false);
  });
});
