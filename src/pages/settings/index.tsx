import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { establishSession, SESSION_LOST_EVENT } from "./session.js";

// konte ends the command when this socket stays closed — the only signal it gets for a browser
// it spawned rather than drives.
function connectKeepAlive(): () => void {
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  let ended = false;
  let current: WebSocket | null = null;
  const connect = () => {
    const ws = new WebSocket(url);
    current = ws;
    ws.addEventListener("close", () => {
      if (ended) return;
      setTimeout(connect, 1000);
    });
    // The session ending is the last thing this socket carries: the window konte opened is not
    // always one it can close from outside, so it closes itself. A browser that refuses to close
    // stops reconnecting either way — a settings page cannot save to a server that has gone.
    ws.addEventListener("message", (event) => {
      try {
        if ((JSON.parse(event.data as string) as { type?: string }).type === "session-ended") {
          ended = true;
          window.dispatchEvent(new CustomEvent("konte:session-ended"));
          window.close();
        }
      } catch {}
    });
  };
  connect();
  return () => {
    ended = true;
    current?.close();
  };
}

const stopKeepAlive = connectKeepAlive();
window.addEventListener(SESSION_LOST_EVENT, stopKeepAlive);

const root = document.getElementById("root");
if (root) {
  void establishSession().then((state) => {
    if (state === "expired") stopKeepAlive();
    createRoot(root).render(<App initialSession={state} />);
  });
}
