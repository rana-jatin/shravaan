/**
 * Device transport smoke test.
 *
 * Proves the device <-> server protocol handshake works. Does NOT exercise the
 * Sarvam providers — those need a live key, and slice 0 has to validate the
 * socket contract before anything can be asserted about them.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { WebSocketServer } from "ws";

const PORT = 18099;
let wss: WebSocketServer;

describe("device transport", () => {
  before(async () => {
    process.env["SARVAM_API_KEY"] = "test-key-not-used-for-network-calls";
    process.env["PORT"] = String(PORT);
    const { start } = await import("../src/server.ts");
    wss = start();
  });

  after(() => {
    wss?.close();
  });

  it("accepts a device and returns a session id", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no ready frame within 3s")), 3000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", uid: "u-test" })));
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString()) as Record<string, unknown>;
        if (msg["type"] === "ready") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    assert.equal(ready["type"], "ready");
    assert.equal(typeof ready["sid"], "string");
    ws.close();
  });

  it("ignores malformed control frames instead of crashing", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send("this is not json");
    // Survival is the assertion: a bad frame from a device must not take the
    // server down for every other session.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });
});
