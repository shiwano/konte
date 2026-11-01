import { KonteError } from "../core/errors.js";

export function formatKonteError(err: KonteError): string {
  const prefix = `Error [${err.code}]: `;
  if (err.items.length === 0) return `${prefix}${err.message}`;
  const items = err.items
    .flatMap((item) => item.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reduce((out, line) => (out === "" ? line : `${out}${out.endsWith(":") ? " " : "; "}${line}`));
  return `${prefix}${err.headline}: ${items}`;
}

export function exitWithError(err: unknown): never {
  if (err instanceof KonteError) {
    console.error(formatKonteError(err));
  } else {
    // A non-KonteError is an unexpected bug: print its stack (not a rethrow, which would
    // surface as an unhandled rejection with no exit code) and exit non-zero.
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    console.error("\nThis is a bug in konte. The konte-feedback skill drafts the report.");
  }
  process.exit(1);
}
