const RECONNECT_DELAY_MS = 1000;

// How long reconnecting runs before the page asks whether the server is there at all. A dropped
// socket is a reload as often as an ending.
const PROBE_AFTER_MS = 15_000;

export function connectKeepAlive(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws`;
  let ended = false;
  let firstFailureAt: number | null = null;

  function endSession() {
    if (ended) return;
    ended = true;
    window.close();
    // A window the page did not open itself — a phone's tab, a plain browser tab — refuses to
    // close, so the page says the session is over instead of sitting on a dead server.
    window.dispatchEvent(new CustomEvent("konte:session-ended"));
  }

  // Whether the server has gone, asked of the server itself. The socket dropping is not an answer
  // — a phone changing network drops one, and a page closed on that would take the comment being
  // typed with it — and neither is a terminal frame that never flushed, which is why the wait ends
  // here rather than in a verdict of its own.
  async function serverIsGone(): Promise<boolean> {
    try {
      const res = await fetch("/api/ping", { cache: "no-store" });
      return !res.ok;
    } catch {
      return true;
    }
  }

  async function probe() {
    if (ended) return;
    if (await serverIsGone()) {
      endSession();
      return;
    }
    firstFailureAt = Date.now();
    setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      firstFailureAt = null;
    });
    ws.addEventListener("close", () => {
      if (ended) return;
      firstFailureAt ??= Date.now();
      if (Date.now() - firstFailureAt >= PROBE_AFTER_MS) {
        void probe();
        return;
      }
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string; payload?: unknown };
        if (data.type === "reload") {
          window.dispatchEvent(new CustomEvent("konte:reload"));
        } else if (data.type === "state-changed") {
          window.dispatchEvent(new CustomEvent("konte:state-changed"));
        } else if (data.type === "session-ended") {
          endSession();
        } else if (data.type === "error") {
          const payload = data.payload as { error: string } | undefined;
          window.dispatchEvent(
            new CustomEvent("konte:error", {
              detail: { error: payload?.error ?? "Unknown error" },
            }),
          );
        }
      } catch {}
    });
  }

  connect();
  preventReload();
}

function preventReload(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
    }
  });
}
