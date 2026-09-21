import { createRoot } from "react-dom/client";
import { App } from "./app.js";

// konte ends the command when this socket stays closed — the only signal it gets for a browser
// it spawned rather than drives.
function connectKeepAlive(): void {
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  let ended = false;
  const connect = () => {
    const ws = new WebSocket(url);
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
          window.close();
        }
      } catch {}
    });
  };
  connect();
}

connectKeepAlive();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
