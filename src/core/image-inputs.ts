// The pictures a declaration was handed, for `plate-unnested` and `landmark-unheld` to tell a cut
// from a previous frame. Free of any DSL/runtime import (like prompt-check.ts).

/**
 * One wired image input that is not a `pin`, as declared at one address: the addresses it was
 * passed, and whether the declaration is generative rather than deterministic.
 */
export type ImageInputOccurrence = {
  address: string;
  sources: readonly string[];
  generative: boolean;
};
