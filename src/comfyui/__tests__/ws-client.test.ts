import * as http from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { KonteError } from "../../core/errors.js";
import { DEFAULT_COMFYUI_TIMING } from "../config.js";
import {
  ComfyUIWsClient,
  type GoneState,
  openComfyWebSocket,
  handleComfyWsMessage,
  registerGonePoll,
} from "../ws-client.js";

describe("openComfyWebSocket", () => {
  it("gives up on a handshake the server neither completes nor refuses", async () => {
    const held: Duplex[] = [];
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    server.on("upgrade", (_req, socket) => held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const opening = openComfyWebSocket(`http://127.0.0.1:${port}`, "c1", {
        headers: {},
        handshakeTimeoutMs: 50,
      });
      await expect(opening).rejects.toMatchObject({
        code: "COMFYUI_WS_UNAVAILABLE",
        message: expect.stringContaining("unanswered for 50ms"),
      });
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("ComfyUIWsClient.waitForPrompt safety net", () => {
  // A socket that never reports, so only the HTTP safety net can end the wait.
  async function withSilentComfy(
    history: () => Response,
    run: (client: ComfyUIWsClient) => Promise<void>,
  ): Promise<void> {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const { pathname } = new URL(req.url);
        if (pathname === "/ws") {
          return srv.upgrade(req) ? undefined : new Response(null, { status: 400 });
        }
        if (pathname === "/history/p1") return history();
        if (pathname === "/queue") {
          return Response.json({ queue_running: [[0, "p1"]], queue_pending: [] });
        }
        return new Response(null, { status: 404 });
      },
      websocket: { message() {} },
    });
    try {
      await run(
        new ComfyUIWsClient(`http://127.0.0.1:${server.port}`, "c1", {
          ...DEFAULT_COMFYUI_TIMING,
          safetyNetIntervalMs: 20,
        }),
      );
    } finally {
      await server.stop(true);
    }
  }

  const entry = (status_str: string, completed: boolean, messages: unknown[] = []) =>
    Response.json({ p1: { outputs: {}, status: { status_str, completed, messages } } });

  it("fails the wait with the execution error the history records", async () => {
    let reads = 0;
    await withSilentComfy(
      () =>
        ++reads === 1
          ? Response.json({})
          : entry("error", false, [
              ["execution_error", { node_id: "7", exception_message: "out of memory" }],
            ]),
      async (client) => {
        await expect(client.waitForPrompt("p1")).rejects.toMatchObject({
          code: "COMFYUI_ERROR",
          message: expect.stringContaining("out of memory"),
        });
      },
    );
  });

  it("keeps waiting through a failed read and finishes on a later success", async () => {
    let reads = 0;
    const onLog = vi.fn();
    await withSilentComfy(
      () => {
        reads++;
        if (reads === 1) return Response.json({});
        if (reads === 2) return new Response("down", { status: 503 });
        return entry("success", true);
      },
      async (client) => {
        await expect(client.waitForPrompt("p1", { onLog })).resolves.toEqual({ kind: "done" });
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining("Polling safety net error"));
      },
    );
  });
});

function freshState(): GoneState {
  return { seen: false, goneStreak: 0, absentSince: null };
}

describe("registerGonePoll", () => {
  it("stays absent (never gone) while the prompt has not yet crossed the orphan grace", () => {
    const state = freshState();
    expect(registerGonePoll(state, false, 0)).toBe("absent");
    expect(registerGonePoll(state, false, 10_000)).toBe("absent");
    expect(registerGonePoll(state, false, 59_999)).toBe("absent");
  });

  it("reports orphaned once absent past the grace window without ever being seen alive", () => {
    const state = freshState();
    expect(registerGonePoll(state, false, 1_000)).toBe("absent"); // anchors absentSince at 1000
    expect(registerGonePoll(state, false, 61_000)).toBe("orphaned"); // +60s -> orphaned
  });

  it("reports gone after the prompt was seen then absent for the streak threshold", () => {
    const state = freshState();
    expect(registerGonePoll(state, true, 0)).toBe("present"); // observed alive
    expect(registerGonePoll(state, false, 1_000)).toBe("absent"); // streak 1
    expect(registerGonePoll(state, false, 2_000)).toBe("gone"); // streak 2 -> gone
  });

  it("resets the streak and grace timer when the prompt reappears", () => {
    const state = freshState();
    registerGonePoll(state, true, 0);
    expect(registerGonePoll(state, false, 1_000)).toBe("absent"); // streak 1
    expect(registerGonePoll(state, true, 2_000)).toBe("present"); // reappeared, reset
    expect(registerGonePoll(state, false, 3_000)).toBe("absent"); // streak 1 again
    expect(registerGonePoll(state, false, 4_000)).toBe("gone"); // streak 2 -> gone
  });

  it("keeps reporting present while the prompt stays alive", () => {
    const state = freshState();
    for (let i = 0; i < 5; i++) {
      expect(registerGonePoll(state, true, i * 1000)).toBe("present");
    }
  });
});

describe("handleComfyWsMessage", () => {
  const PROMPT = "p-1";
  function handlers() {
    return {
      onExecutionStarted: vi.fn(),
      onProgress: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
  }
  const send = (h: ReturnType<typeof handlers>, msg: unknown) =>
    handleComfyWsMessage(JSON.stringify(msg), PROMPT, h);

  it("reports execution start on execution_start, nothing else", () => {
    const h = handlers();
    send(h, { type: "execution_start", data: { prompt_id: PROMPT } });
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(h.onProgress).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reports execution start and forwards the value on progress", () => {
    const h = handlers();
    send(h, { type: "progress", data: { prompt_id: PROMPT, value: 3, max: 10 } });
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(h.onProgress).toHaveBeenCalledWith({ value: 3, max: 10 });
  });

  it("treats executing with a node as an in-progress start, not completion", () => {
    const h = handlers();
    send(h, { type: "executing", data: { prompt_id: PROMPT, node: "7" } });
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(h.onProgress).toHaveBeenCalledWith({ value: 0, max: 100, node: "7" });
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("treats executing with a null node as completion", () => {
    const h = handlers();
    send(h, { type: "executing", data: { prompt_id: PROMPT, node: null } });
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
    expect(h.onProgress).not.toHaveBeenCalled();
  });

  it("routes execution_error to onError as a COMFYUI_ERROR naming the node", () => {
    const h = handlers();
    send(h, {
      type: "execution_error",
      data: {
        prompt_id: PROMPT,
        node_id: "12",
        exception_type: "ValueError",
        exception_message: "bad input",
      },
    });
    expect(h.onError).toHaveBeenCalledTimes(1);
    const err = h.onError.mock.calls[0]![0] as KonteError;
    expect(err).toBeInstanceOf(KonteError);
    expect(err.code).toBe("COMFYUI_ERROR");
    expect(err.message).toContain("node 12");
    expect(err.message).toContain("ValueError");
    expect(err.message).toContain("bad input");
  });

  it("ignores a frame for a different prompt", () => {
    const h = handlers();
    handleComfyWsMessage(
      JSON.stringify({ type: "executing", data: { prompt_id: "other", node: null } }),
      PROMPT,
      h,
    );
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
  });

  it("ignores frames without the {data, prompt_id} shape and unparseable text", () => {
    const h = handlers();
    send(h, { type: "status", data: { status: {} } });
    handleComfyWsMessage("not json", PROMPT, h);
    handleComfyWsMessage("{}", PROMPT, h);
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
    expect(h.onProgress).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  // Valid JSON, wrong shape: the `in` checks must not throw on a non-object or a null data.
  it("ignores valid-JSON frames of the wrong shape without throwing", () => {
    const h = handlers();
    for (const raw of [
      "null",
      '"a string"',
      "42",
      '{"data":null}',
      '{"type":"progress","data":null}',
    ]) {
      expect(() => handleComfyWsMessage(raw, PROMPT, h)).not.toThrow();
    }
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
    expect(h.onProgress).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
});
