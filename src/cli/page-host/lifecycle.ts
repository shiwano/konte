import type { ServerWebSocket, WebSocketHandler } from "bun";

// Long enough for the heaviest submit (a whole-video review's accepts, note frames and content
// hashes), short enough that a wedged handler cannot hold the session open forever.
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

// Bun infers the socket's `data` from the handler; nothing here attaches any, and `undefined`
// is what lets `server.upgrade(req)` be called without one.
type PageSocket = ServerWebSocket<undefined>;

const SESSION_ENDED = JSON.stringify({ type: "session-ended" });

export interface PageShutdownResult {
  /** Tracked work outstripped the drain cap, so what it wrote may be half-written. */
  drainTimedOut: boolean;
}

interface PageLifecycleOptions {
  /** End the session once the page goes away. */
  autoClose: boolean;
  /** Runs once, after tracked work has drained and after the server stops accepting. */
  onShutdown?: (result: PageShutdownResult) => void | Promise<void>;
  onSocketOpen?: (ws: PageSocket) => void;
  onSocketClose?: (ws: PageSocket) => void;
  /** Cap on how long shutdown waits for tracked work. */
  drainTimeoutMs?: number;
}

interface PageLifecycle {
  shutdown: Promise<PageShutdownResult>;
  triggerShutdown: () => void;
  /**
   * Run a handler as tracked work. Bun's `stop()` lets an in-flight request run on unwatched, so a
   * shutdown racing one would report the session before that work finished — and what it reported
   * would be whatever the handler had not yet written down. Shutdown waits for these instead.
   */
  track: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Whether the session is ending. Bun's stop() turns away new connections but still serves a
   * request sent over one the page already holds open, so a write route asks this before starting:
   * work begun after the drain was sized would run unwatched, which is the fault this path fixes.
   */
  isShuttingDown: () => boolean;
  /** Hand over the running server, so shutting down can stop it. */
  attach: (server: { stop: () => void }) => void;
  /** Bun.serve's `websocket` handlers: the page's keepalive socket is how it reports being open. */
  websocket: WebSocketHandler<undefined>;
  /** The page asked to close (POST /api/close). */
  requestClose: () => void;
}

export function createPageLifecycle(opts: PageLifecycleOptions): PageLifecycle {
  let server: { stop: () => void } | null = null;
  const sockets = new Set<PageSocket>();
  let activeConnections = 0;
  let hasEverConnected = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  let resolveShutdown!: (result: PageShutdownResult) => void;
  const shutdown = new Promise<PageShutdownResult>((resolve) => {
    resolveShutdown = resolve;
  });

  function track<T>(fn: () => Promise<T>): Promise<T> {
    inFlight++;
    return fn().finally(() => {
      inFlight--;
      if (inFlight > 0) return;
      for (const waiter of [...drainWaiters]) waiter();
    });
  }

  function drained(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    // The wait is announced on stderr: a Ctrl+C that appears to hang is worse than a line a
    // piped read never sees.
    process.stderr.write(`Finishing ${inFlight} in-flight request(s) before exit\n`);
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        drainWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, drainTimeoutMs);
      drainWaiters.add(finish);
    });
  }

  function triggerShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Sent before the stop, while the sockets are still up: a session that ends for a reason the
    // page has no part in — a Ctrl+C here, another reviewer's submit on the tunnel — reaches every
    // open page only through this.
    for (const ws of sockets) {
      try {
        ws.send(SESSION_ENDED);
      } catch {}
    }

    void (async () => {
      // Stopped before the drain, not after it: Bun's stop() turns new requests away while letting
      // the in-flight ones run on, so nothing can start work the drain has already waited past.
      server?.stop();
      let result: PageShutdownResult = { drainTimedOut: false };
      try {
        await drained();
        result = { drainTimedOut: inFlight > 0 };
        await opts.onShutdown?.(result);
      } catch (err) {
        // A throwing report must not strand the session — whoever is awaiting `shutdown` is the one
        // who would then exit the process — nor escape as an unhandled rejection from this detached
        // call. Both leave the exit unexplained, which is the failure this whole path is here for.
        console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      } finally {
        resolveShutdown(result);
      }
    })();
  }

  function scheduleShutdown() {
    if (!opts.autoClose || !hasEverConnected) return;
    if (activeConnections > 0) return;
    closeTimer = setTimeout(triggerShutdown, 5000);
  }

  return {
    shutdown,
    triggerShutdown,
    track,
    isShuttingDown: () => shuttingDown,
    attach(next) {
      server = next;
    },
    requestClose() {
      if (!opts.autoClose || !hasEverConnected) return;
      if (closeTimer) clearTimeout(closeTimer);
      setTimeout(triggerShutdown, 0);
    },
    websocket: {
      idleTimeout: 0,
      sendPings: true,
      open(ws) {
        sockets.add(ws);
        activeConnections++;
        hasEverConnected = true;
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        opts.onSocketOpen?.(ws);
      },
      close(ws) {
        sockets.delete(ws);
        activeConnections--;
        opts.onSocketClose?.(ws);
        scheduleShutdown();
      },
      message() {},
    },
  };
}
