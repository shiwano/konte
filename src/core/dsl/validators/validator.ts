import { KonteError } from "../../errors.js";

/**
 * A cross-input constraint the adapter's schema cannot express (H3's `<Picture N>` ordinals). It is
 * handed the resolved inputs keyed by input name — caller value, default or format-derived, with an
 * omitted one absent — and returns why it rejects them, or nothing when they pass. Must be pure and
 * deterministic: a media value is a `__konte:…__` placeholder during discovery and a file path
 * during a render, and only its presence is the same in both.
 */
export type AdapterValidator = ((
  inputs: Readonly<Record<string, unknown>>,
  context?: AdapterValidatorContext,
) => string | undefined) & {
  // The adapter inputs this validator names, checked by `assertValidatorInputs`.
  //
  // The bundled validator factories fill it. A hand-written validator is a bare function and
  // declares nothing, so the check covers it only as far as its author sets this.
  inputs?: readonly string[];
};

/**
 * The adapter's own shape: `promptInput` is the name of its one `"prompt"` input, undefined when it
 * declares none or several. `shotId` is the shot the asset is declared in, undefined outside one.
 */
export type AdapterValidatorContext = { promptInput?: string; shotId?: string };

// The adapter's single `"prompt"` input, or undefined when it has none or more than one. A
// `"negativePrompt"` is not one of them.
export function promptInputName(inputs: Record<string, { type: string }>): string | undefined {
  const named = Object.entries(inputs)
    .filter(([, def]) => def.type === "prompt")
    .map(([name]) => name);
  return named.length === 1 ? named[0] : undefined;
}

// An adapter may carry several independent validators; they run in declaration order, and the first
// to reject is the one reported.
// A validator naming an input the adapter does not declare reads it as unset, so it fires on nothing
// and the gate passes every take. Rejected where the adapter is declared, as `fixed` inputs are.
export function assertValidatorInputs(
  validators: AdapterValidator | readonly AdapterValidator[] | undefined,
  inputs: Record<string, unknown>,
): void {
  if (!validators) return;
  for (const validator of Array.isArray(validators)
    ? validators
    : [validators as AdapterValidator]) {
    for (const name of validator.inputs ?? []) {
      if (!Object.hasOwn(inputs, name)) {
        throw new Error(`a validator names input "${name}", which this adapter does not declare`);
      }
    }
  }
}

export function runValidators(
  validators: AdapterValidator | readonly AdapterValidator[] | undefined,
  inputs: Readonly<Record<string, unknown>>,
  context: AdapterValidatorContext = {},
): void {
  if (!validators) return;
  for (const validator of Array.isArray(validators)
    ? validators
    : [validators as AdapterValidator]) {
    const rejection = validator(inputs, context);
    if (rejection) throw new KonteError("INVALID_ADAPTER_INPUT", rejection);
  }
}
