interface Child {
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

// Run the re-exec'd child to its exit, forwarding the signals this process takes to it — except a
// SIGINT with a terminal attached: on unix a terminal delivers Ctrl-C to the whole foreground group,
// so the child has it, and `preview` reads a second SIGINT as "stop now" and drops the exit line
// the review is read from.
export async function superviseChild(
  child: Child,
  opts: { forwardSigint: boolean },
): Promise<number> {
  // Handling a signal suppresses the default termination, so a forward that quietly failed would
  // leave both processes alive and unkillable. Windows has no real signals and may reject the
  // name, so fall back to plain termination, and to leaving rather than hanging.
  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
      return;
    } catch {
      // Not a signal this platform can send.
    }
    try {
      child.kill();
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
  return child.exited;
}
