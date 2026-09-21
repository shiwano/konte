type IdentifierChar =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "-"
  | "_";

type IsIdentifierString<T extends string> = T extends ""
  ? false
  : T extends `${IdentifierChar}${infer Rest}`
    ? Rest extends ""
      ? true
      : IsIdentifierString<Rest>
    : false;

export type Identifier<T extends string> = string extends T
  ? T
  : IsIdentifierString<T> extends true
    ? T
    : never;

/**
 * A branded error carrying the offending id in a required property KEY, so a violation surfaces the
 * whole explanation verbatim ("Property 'konte: id "…" …' is missing").
 */
export type IdentifierViolation<T extends string> = {
  [P in `konte: id "${T}" must use only a-z A-Z 0-9 - _`]: never;
};

// Type-level id gate: a valid literal (or the non-literal `string`) passes through unchanged, an
// invalid literal maps to its `IdentifierViolation`. Assigning a bad id to this then fails at the
// id's own position — see `ConstrainIds` in direction.ts for how the direction applies it.
export type ValidatedIdentifier<T extends string> =
  Identifier<T> extends never ? IdentifierViolation<T> : T;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

export function validateShotId(id: string): void {
  if (!IDENTIFIER_PATTERN.test(id)) {
    throw new Error(
      `Invalid shot ID "${id}": must contain only alphanumeric characters, hyphens, and underscores (a-z, A-Z, 0-9, -, _)`,
    );
  }
}

export function validateAssetName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid asset name "${name}": must contain only alphanumeric characters, hyphens, and underscores (a-z, A-Z, 0-9, -, _)`,
    );
  }
  // `patch` heads the patch address axis. A reference asset's suffix is a bare name, so without
  // this the scope `reference:patch` would name both that asset and the whole patch axis.
  if (name === "patch") {
    throw new Error(`Asset name "patch" is reserved. It heads the patch address axis.`);
  }
}
