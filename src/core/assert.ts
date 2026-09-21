// Exhaustiveness guard for discriminated unions: place in a `default` branch (or after an
// exhaustive `if`/`switch`) so adding a new variant becomes a compile error here. Reaching it
// at runtime is a programmer bug, not a domain error — hence a plain Error, not a KonteError.
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unreachable: unhandled variant ${JSON.stringify(value)}${context ? ` (${context})` : ""}`,
  );
}
