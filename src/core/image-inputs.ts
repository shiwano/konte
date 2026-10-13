// The pictures a declaration was handed, for `panel-unlinked` and `plate-unnested` to tell a cut
// from a previous frame. Free of any DSL/runtime import (like prompt-check.ts).

/**
 * One wired image input that is not a `pin`, as declared at one address: the addresses it was
 * passed.
 */
export type ImageInputOccurrence = {
  address: string;
  sources: readonly string[];
};
