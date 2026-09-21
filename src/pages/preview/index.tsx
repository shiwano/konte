import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { connectKeepAlive } from "./ws-keepalive.js";

connectKeepAlive();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
