import { describe, expect, it, vi } from "vitest";
import type { ServerWebSocket } from "bun";
import { createPageLifecycle } from "../lifecycle.js";

// The reported gap: a review submitted from a phone on `--tunnel` ended the session, and the
// browser window konte had opened on the machine stayed open on a server that was gone.

// Bun's `send` returns the bytes written — 0 when the frame was dropped, -1 when backpressure
// queued it. Modelled here so no test reads a dropped send as a delivered one.
function fakeSocket(result: "sent" | "dropped" = "sent") {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => {
      sent.push(data);
      return result === "dropped" ? 0 : Buffer.byteLength(data);
    },
  } as unknown as ServerWebSocket<undefined>;
  return { ws, sent };
}

describe("page lifecycle — telling the page the session ended", () => {
  it("tells every open page, so a window konte cannot close closes itself", async () => {
    const lifecycle = createPageLifecycle({ autoClose: true });
    lifecycle.attach({ stop: () => {} });

    const local = fakeSocket();
    const phone = fakeSocket();
    lifecycle.websocket.open?.(local.ws);
    lifecycle.websocket.open?.(phone.ws);

    lifecycle.triggerShutdown();
    await lifecycle.shutdown;

    for (const socket of [local, phone]) {
      expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ type: "session-ended" }]);
    }
  });

  it("sends before the server stops, while the sockets are still up", async () => {
    const order: string[] = [];
    const lifecycle = createPageLifecycle({ autoClose: true });
    lifecycle.attach({ stop: () => order.push("stop") });

    const page = {
      send: (data: string) => {
        order.push("send");
        return Buffer.byteLength(data);
      },
    } as unknown as ServerWebSocket<undefined>;
    lifecycle.websocket.open?.(page);

    lifecycle.triggerShutdown();
    await lifecycle.shutdown;

    expect(order).toEqual(["send", "stop"]);
  });

  it("does not send to a page that has already gone", async () => {
    const lifecycle = createPageLifecycle({ autoClose: false });
    lifecycle.attach({ stop: () => {} });

    const gone = fakeSocket();
    lifecycle.websocket.open?.(gone.ws);
    lifecycle.websocket.close?.(gone.ws, 1000, "");

    lifecycle.triggerShutdown();
    await lifecycle.shutdown;

    expect(gone.sent).toEqual([]);
  });

  // Neither of the two ways a frame fails to land is one the session can do anything about — the
  // page's liveness probe is what covers them — so the only thing asserted is that shutdown still
  // completes and still reports.
  it("shuts down cleanly when the frame is dropped rather than sent", async () => {
    const reported: string[] = [];
    const lifecycle = createPageLifecycle({
      autoClose: true,
      onShutdown: () => {
        reported.push("shutdown");
      },
    });
    lifecycle.attach({ stop: () => {} });

    const dropped = fakeSocket("dropped");
    lifecycle.websocket.open?.(dropped.ws);

    lifecycle.triggerShutdown();
    await expect(lifecycle.shutdown).resolves.toEqual({ drainTimedOut: false });
    expect(reported).toEqual(["shutdown"]);
  });

  it("survives a socket that is already closed", async () => {
    const lifecycle = createPageLifecycle({ autoClose: true });
    const stop = vi.fn();
    lifecycle.attach({ stop });

    const dead = {
      send: () => {
        throw new Error("socket closed");
      },
    } as unknown as ServerWebSocket<undefined>;
    lifecycle.websocket.open?.(dead);

    lifecycle.triggerShutdown();
    await expect(lifecycle.shutdown).resolves.toEqual({ drainTimedOut: false });
    expect(stop).toHaveBeenCalledOnce();
  });
});
