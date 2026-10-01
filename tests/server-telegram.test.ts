import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { config } from "../src/config.js";
import { registerService } from "../src/messaging/services.js";
import { createServer } from "../src/webhook/server.js";
import type { IMessagingService, SendInput } from "../src/messaging/types.js";

const received: unknown[] = [];

const fake: IMessagingService = {
  platform: "telegram",
  init: async () => {},
  healthCheck: async () => true,
  recover: async () => true,
  sendAdvanced: async (_inputs: SendInput[]) => {},
  schedule: () => ({}) as never,
  updateScheduled: () => null,
  listScheduled: () => [],
  cancelScheduled: () => false,
  listTargets: () => [],
  refreshContacts: async () => {},
  getQueueStats: () => ({ pending: 0, running: false }),
  handleIncoming: async (payload: unknown) => {
    received.push(payload);
  },
  stopListening: () => {},
  stopQueue: () => {},
};

let server: Server;
let base = "";

before(async () => {
  registerService(fake);
  config.telegram.enabled = true;
  config.telegram.botToken = "123:abc";
  config.telegram.secretToken = "s3cret";
  const app = createServer(fake);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/tg/update secret token 驗證", () => {
  it("帶正確密鑰 → 200 並轉交 handleIncoming", async () => {
    received.length = 0;
    const res = await post(
      "/tg/update",
      { update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: "hi" } },
      { "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 1);
  });

  it("密鑰錯誤 → 403 且不轉交", async () => {
    received.length = 0;
    const res = await post("/tg/update", { update_id: 2 }, { "X-Telegram-Bot-Api-Secret-Token": "wrong" });
    assert.equal(res.status, 403);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 0);
  });

  it("未設密鑰時不驗證（放行）", async () => {
    config.telegram.secretToken = "";
    const res = await post("/tg/update", { update_id: 3 });
    assert.equal(res.status, 200);
    config.telegram.secretToken = "s3cret";
  });

  it("Telegram 未啟用 → 503", async () => {
    config.telegram.enabled = false;
    const res = await post("/tg/update", { update_id: 4 });
    assert.equal(res.status, 503);
    config.telegram.enabled = true;
  });
});
