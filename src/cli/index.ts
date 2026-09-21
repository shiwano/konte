#!/usr/bin/env bun
import { closeSync, openSync } from "node:fs";
import { superviseChild } from "./supervise.js";
import { TRANSPILER_CACHE_ENV, resolveTranspilerCachePath } from "./transpiler-cache.js";

// Replaced by `true` when bun builds the standalone binary; absent under `bun run`.
declare const KONTE_COMPILED: boolean | undefined;

// Whether a terminal can be signalling this process group. Asked of the controlling terminal rather
// than of the descriptors, which say nothing: `konte preview > log 2>&1 < /dev/null` still takes a
// Ctrl-C. Windows has no /dev/tty and hands a console Ctrl-C to every attached process, so there the
// descriptors are all there is.
function hasControllingTerminal(): boolean {
  if (process.platform === "win32") {
    return Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
  }
  try {
    closeSync(openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
}

// The CLI entry, which carries no heavy static imports: ESM evaluates the whole import graph before
// this body runs, and the re-exec below has to happen before konte's own modules — and any user
// definition file — are loaded.
//
// The re-exec is what points Bun's runtime transpiler cache at the workspace (see
// transpiler-cache.ts for why nothing cheaper works). The guard is the resolved path rather than
// the variable's mere presence: a nested konte run against another workspace needs its own cache.
if (import.meta.main) {
  const cache = resolveTranspilerCachePath(process.argv.slice(2));

  if (process.env[TRANSPILER_CACHE_ENV] === cache) {
    const { run } = await import("./program.js");
    await run();
  } else {
    // A standalone binary takes its arguments at argv[2..]; under `bun run`, argv[1] is this file
    // and has to be passed back so the child runs the CLI rather than a REPL. Which one this is
    // comes from a build-time define (compile-binary.ts) rather than the shape of the virtual path
    // Bun serves the bundle from, which differs per platform and is not a documented contract.
    const args = process.argv.slice(2);
    const cmd =
      typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED
        ? [process.execPath, ...args]
        : [process.execPath, process.argv[1]!, ...args];
    const env = { ...process.env, [TRANSPILER_CACHE_ENV]: cache };
    // A daemon that finds its loaded definitions older than the files on disk exits asking to be
    // started again (see process-restart.ts); the child it gets keeps the same stdio.
    const code = await superviseChild(
      () => Bun.spawn({ cmd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
      // A SIGINT aimed at this pid while a terminal is attached — of which a backgrounded
      // `konte preview &` is the real case — is not forwarded: it keeps the controlling terminal
      // but leaves the foreground group, so no Ctrl-C reaches it either. SIGTERM stops those.
      { forwardSigint: !hasControllingTerminal() },
    );
    process.exit(code);
  }
}
