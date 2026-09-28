import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchText, fetchJson, FetchLimitError } from "../src/net.js";

let base = "";
let server: Server;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/small") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello");
        return;
      }
      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(100_000));
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("late");
        }, 2000);
        return;
      }
      res.writeHead(404);
      res.end();
    }).listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("net fetch helper", () => {
  it("正常小回應", async () => {
    assert.equal(await fetchText(`${base}/small`), "hello");
  });

  it("fetchJson 解析", async () => {
    assert.deepEqual(await fetchJson<{ ok: boolean }>(`${base}/json`), { ok: true });
  });

  it("超過 maxBytes 丟 FetchLimitError", async () => {
    await assert.rejects(fetchText(`${base}/big`, undefined, { maxBytes: 1024 }), FetchLimitError);
  });

  it("超時丟錯（不無限等待）", async () => {
    await assert.rejects(fetchText(`${base}/slow`, undefined, { timeoutMs: 200 }), (e: unknown) => {
      return e instanceof Error && e.name === "TimeoutError";
    });
  });

  it("404 丟錯", async () => {
    await assert.rejects(fetchText(`${base}/missing`), /HTTP 404/);
  });
});
