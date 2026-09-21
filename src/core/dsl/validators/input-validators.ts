import type { AdapterValidator } from "./validator.js";

/**
 * The value (or values) an input carries when it is not set — an empty string, a `"Auto"` menu
 * entry, the space a workflow leaves in a negative prompt. An absent input is always unset.
 */
export type UnsetValue = string | number | boolean | readonly (string | number | boolean)[];

/**
 * An equality match over other resolved inputs. It holds when every entry does.
 */
export type InputMatch = Readonly<Record<string, string | number | boolean>>;

export interface InertInputsSpec {
  // Input name → the value that means "not set". Setting any of them under the condition is the
  // error.
  inputs: Readonly<Record<string, UnsetValue>>;
  // The condition. `when` holds when its match does; `whenNot` when its match does not — negated as
  // a whole, so one entry differing is enough. `whenUnset` holds when every input it names is
  // unset. Combined, all of them have to hold.
  when?: InputMatch;
  whenNot?: InputMatch;
  whenUnset?: Readonly<Record<string, UnsetValue>>;
  // Why the model ignores them, and what to change. Both are shown verbatim.
  reason: string;
  fix: string;
}

/**
 * Rejects an input the model will not read in the configuration it was given: a negative prompt
 * under a sampler running at CFG 1, a preset menu overridden by a prose description. Nothing fails
 * at generation time — the take comes back as if the input had never been written.
 */
export function inertInputs(spec: InertInputsSpec): AdapterValidator {
  const validator: AdapterValidator = (inputs) => {
    if (spec.when && !allMatch(spec.when, inputs)) return;
    if (spec.whenNot && allMatch(spec.whenNot, inputs)) return;
    if (spec.whenUnset && !allUnset(spec.whenUnset, inputs)) return;

    const set = Object.keys(spec.inputs).filter(
      (name) => !isUnset(inputs[name], spec.inputs[name]!),
    );
    if (set.length === 0) return;

    const one = set.length === 1;
    return (
      `${set.map((name) => `"${name}"`).join(", ")} ${one ? "is" : "are"} set, but ${spec.reason}, ` +
      `so ${one ? "it" : "they"} would not be read at all. ${spec.fix}`
    );
  };
  validator.inputs = [
    ...new Set([
      ...Object.keys(spec.inputs),
      ...Object.keys(spec.when ?? {}),
      ...Object.keys(spec.whenNot ?? {}),
      ...Object.keys(spec.whenUnset ?? {}),
    ]),
  ];
  return validator;
}

export interface RequireOneOfSpec {
  // Input name → the value that means "not set". At least one must differ from it.
  inputs: Readonly<Record<string, UnsetValue>>;
  // What the set of them supplies, and what to do. Shown verbatim.
  reason: string;
}

/**
 * Rejects a combination in which nothing supplies something the model requires. Each input alone is
 * optional — it is their all being unset that the model rejects.
 */
export function requireOneOf(spec: RequireOneOfSpec): AdapterValidator {
  const names = Object.keys(spec.inputs);
  const validator: AdapterValidator = (inputs) => {
    if (names.some((name) => !isUnset(inputs[name], spec.inputs[name]!))) return;
    return `None of ${names.map((name) => `"${name}"`).join(", ")} is set — ${spec.reason}`;
  };
  validator.inputs = names;
  return validator;
}

function allMatch(match: InputMatch, inputs: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(match).every(([name, value]) => inputs[name] === value);
}

function allUnset(
  match: Readonly<Record<string, UnsetValue>>,
  inputs: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(match).every(([name, unset]) => isUnset(inputs[name], unset));
}

function isUnset(value: unknown, unset: UnsetValue): boolean {
  if (value === undefined) return true;
  return Array.isArray(unset) ? unset.includes(value as never) : value === unset;
}
