import { RESTART_EXIT_CODE } from "../core/process-restart.js";

interface Child {
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

// Run the re-exec'd child until it exits with anything but RESTART_EXIT_CODE, spawning a fresh
// one in its place each time it asks: the child inherits this process's stdio, so a restarted
// daemon keeps the pipes its MCP client is holding. Signals are forwarded to whichever child is
// current, so a signal this process takes never leaves a child running under a parent that can no
// longer be reached — except a SIGINT with a terminal attached: on unix a terminal delivers Ctrl-C
// to the whole foreground group, so the child has it, and `preview` reads a second SIGINT as
// "stop now" and drops the exit line the review is read from.
export async function superviseChild(
  spawn: () => Child,
  opts: { forwardSigint: boolean },
): Promise<number> {
  let current = spawn();
  // Handling a signal suppresses the default termination, so a forward that quietly failed would
  // leave both processes alive and unkillable. Windows has no real signals and may reject the
  // name, so fall back to plain termination, and to leaving rather than hanging.
  const forward = (signal: NodeJS.Signals) => {
    try {
      current.kill(signal);
      return;
    } catch {
      // Not a signal this platform can send.
    }
    try {
      current.kill();
      return;
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGINT", () => {
    if (opts.forwardSigint) forward("SIGINT");
  });
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => forward(signal));
  }
  for (;;) {
    const code = await current.exited;
    if (code !== RESTART_EXIT_CODE) return code;
    current = spawn();
  }
}
