import { KonteError } from "../errors.js";

/**
 * One field of a structured `"prompt"` input. `render` turns the caller's value into its section;
 * its parameter type is the type the caller passes. A `render` taking no argument is a constant
 * section: always written, never passed.
 */
export interface PromptStructureField {
  render: (value: never) => string;
  required?: boolean;
  // Printed by `adapter show` beside the field.
  description?: string;
}

/**
 * How a `"prompt"` input is assembled from fields: each field that has a value, rendered, in
 * declaration order, joined by `join`.
 */
export interface PromptStructure {
  join: string;
  fields: Record<string, PromptStructureField>;
}

type Fields<S extends PromptStructure> = S["fields"];

type ValuedFieldKey<S extends PromptStructure> = {
  [K in keyof Fields<S>]: Parameters<Fields<S>[K]["render"]> extends [] ? never : K;
}[keyof Fields<S>];

type RequiredFieldKey<S extends PromptStructure> = {
  [K in ValuedFieldKey<S>]: Fields<S>[K] extends { required: true } ? K : never;
}[ValuedFieldKey<S>];

type FieldValue<F extends PromptStructureField> = Parameters<F["render"]>[0];

export type PromptStructureValue<S extends PromptStructure> = {
  [K in RequiredFieldKey<S>]: FieldValue<Fields<S>[K]>;
} & {
  [K in Exclude<ValuedFieldKey<S>, RequiredFieldKey<S>>]?: FieldValue<Fields<S>[K]>;
};

/** A structured prompt on the meta: the fields a caller passes, and the assembly `asset()` runs. */
export interface PromptStructureMeta {
  fields: Record<string, { required: boolean; description?: string }>;
  assemble: (value: unknown) => string;
}

function isConstant(field: PromptStructureField): boolean {
  return field.render.length === 0;
}

export function promptStructureMeta(
  input: string,
  structure: PromptStructure,
): PromptStructureMeta {
  const fields = Object.fromEntries(
    Object.entries(structure.fields)
      .filter(([, field]) => !isConstant(field))
      .map(([name, field]) => [
        name,
        {
          required: field.required === true,
          ...(field.description ? { description: field.description } : {}),
        },
      ]),
  );
  return { fields, assemble: (value) => assemblePrompt(input, structure, value) };
}

function assemblePrompt(input: string, structure: PromptStructure, value: unknown): string {
  const names = Object.keys(structure.fields).filter((n) => !isConstant(structure.fields[n]!));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KonteError(
      "INVALID_ADAPTER_INPUT",
      `Input "${input}" takes its fields as an object — ${names.join(", ")} — not ${
        typeof value === "string" ? "a string" : JSON.stringify(value)
      }`,
    );
  }
  const given = value as Record<string, unknown>;
  const unknown = Object.keys(given).filter((n) => !names.includes(n));
  if (unknown.length > 0) {
    throw new KonteError(
      "INVALID_ADAPTER_INPUT",
      `Input "${input}" has no field ${unknown.map((n) => `"${n}"`).join(", ")}. Its fields are: ${names.join(", ")}`,
    );
  }
  const sections: string[] = [];
  for (const [name, field] of Object.entries(structure.fields)) {
    const constant = isConstant(field);
    const fieldValue = given[name];
    if (!constant && fieldValue === undefined) {
      if (field.required) {
        throw new KonteError(
          "MISSING_REQUIRED_INPUT",
          `Required field "${name}" of input "${input}" was not provided`,
        );
      }
      continue;
    }
    try {
      sections.push(
        constant ? (field.render as () => string)() : field.render(fieldValue as never),
      );
    } catch (error) {
      throw new KonteError(
        "INVALID_ADAPTER_INPUT",
        `Field "${name}" of input "${input}" could not be rendered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return sections.join(structure.join);
}

/**
 * Replaces every structured `"prompt"` value with the string its fields assemble into — what the
 * definition, the prompt check and the validators all read.
 */
export function assemblePromptInputs<T>(
  inputs: Readonly<Record<string, { structure?: PromptStructureMeta }>>,
  values: T,
): T {
  let assembled: Record<string, unknown> | undefined;
  for (const [name, def] of Object.entries(inputs)) {
    if (!def.structure) continue;
    const value = (values as Record<string, unknown>)[name];
    if (value === undefined) continue;
    assembled ??= { ...(values as Record<string, unknown>) };
    assembled[name] = def.structure.assemble(value);
  }
  return (assembled ?? values) as T;
}

/** `seconds` as `mm:ss.mmm`, rounded to the millisecond first (`59.9996` is `01:00.000`). */
export function formatCutTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`A cut time is a non-negative number of seconds, not ${seconds}`);
  }
  const ms = Math.round(seconds * 1000);
  const minutes = Math.floor(ms / 60000);
  const rest = ms - minutes * 60000;
  const secs = Math.floor(rest / 1000);
  const millis = rest - secs * 1000;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
