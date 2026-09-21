import { launchBrowser } from "./launch-browser.js";
import type { PageShutdownResult } from "./lifecycle.js";

export interface PageServerHandle {
  port: number;
  shutdown: Promise<PageShutdownResult>;
  triggerShutdown: () => void;
}

interface RunPageOptions {
  startupLine: (url: string, port: number) => string;
  /** Path and query the browser opens at. */
  path?: string;
  start: () => Promise<PageServerHandle>;
}

export async function runPage(opts: RunPageOptions): Promise<void> {
  const server = await opts.start();
  const url = `http://127.0.0.1:${server.port}${opts.path ?? ""}`;

  const startupLine = opts.startupLine(url, server.port);
  console.log(startupLine);

  let signalled = false;
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    // A second signal gives up on the drain: the first one has already said what it is waiting for.
    if (signalled) process.exit(signal === "SIGTERM" ? 143 : 130);
    signalled = true;
    server.triggerShutdown();
    void server.shutdown.then((result) => {
      // process.stdout is an async pipe when the caller captures it, so exiting straight after the
      // write can truncate the summary. Exit from a write callback, which runs once it has flushed.
      process.stdout.write("", () => process.exit(result.drainTimedOut ? 1 : 0));
    });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  launchBrowser(url);

  const result = await server.shutdown;
  // Non-zero when work was cut short: the session cannot say what that work finished, and a caller
  // that reads only the exit code would otherwise read it as a clean end.
  if (result.drainTimedOut) process.exitCode = 1;
}
