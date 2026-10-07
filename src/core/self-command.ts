// Replaced by `true` when bun builds the standalone binary; absent under `bun run`.
declare const KONTE_COMPILED: boolean | undefined;

/** The argv that runs this konte with `args`: the binary itself, or bun with the CLI entry. */
export function selfCommand(args: readonly string[]): [string, ...string[]] {
  return typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED
    ? [process.execPath, ...args]
    : [process.execPath, process.argv[1]!, ...args];
}
