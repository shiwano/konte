import { parsePlaceholder } from "../core/dsl/shot-context.js";
import { KonteError } from "../core/errors.js";
import { requireFileWithinRoot } from "../core/path-containment.js";

// Resolve an asset definition's inputs for submission: expand a `seed` placeholder to the
// job's seed, upload a dependency placeholder's resolved file and substitute its URL, and
// pass everything else through. A placeholder that names a dependency with no resolved file
// throws DEPENDENCY_NOT_RESOLVED — never silently dropped or left as a raw placeholder, so a
// shrunk input list can't be submitted (and charged) against.
//
// The `seed` is generated once per job by the caller and reused for every `__konte:seed__`
// occurrence, so the single persisted seed faithfully reproduces the submission.
//
// Recurses into arrays and plain objects, mirroring the dependency graph's `collectRefs`
// (graph.ts) so a placeholder at any depth — e.g. a media input targeting a nested provider
// field via `setFieldPath` — is resolved the same way it was ordered for generation. A
// non-plain object (Date, class instance, anything with a custom `toJSON`) is passed through
// untouched so its own JSON serialization is preserved rather than flattened to `{}`.
export function prepareBackendInputs(
  inputs: Record<string, unknown>,
  resolvedDependencies: Record<string, string>,
  videoRoot: string,
  uploadFile: (absPath: string) => Promise<string>,
  seed: number,
): Promise<Record<string, unknown>> {
  const resolve = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string") {
      const placeholder = parsePlaceholder(value);
      if (placeholder === "seed") {
        return seed;
      }
      if (placeholder) {
        const depPath = resolvedDependencies[placeholder];
        if (!depPath) {
          throw new KonteError(
            "DEPENDENCY_NOT_RESOLVED",
            `Input placeholder "${placeholder}" has no resolved dependency`,
          );
        }
        const absPath = await requireFileWithinRoot(videoRoot, depPath);
        return uploadFile(absPath);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map(resolve));
    }
    if (value && typeof value === "object" && isPlainObject(value)) {
      // Object.create(null) so a literal "__proto__" field can't mutate the prototype.
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, v] of Object.entries(value)) {
        out[key] = await resolve(v);
      }
      return out;
    }
    return value;
  };

  return resolve(inputs) as Promise<Record<string, unknown>>;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Whether a definition's inputs reference `__konte:seed__` anywhere. Mirrors the resolver's
// recursion (arrays + plain objects) so the seam records a variant's seed only when it was
// actually consumed — a seedless asset never gets a phantom seed that would mislead restore.
export function hasSeedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return parsePlaceholder(value) === "seed";
  if (Array.isArray(value)) return value.some(hasSeedPlaceholder);
  if (value && typeof value === "object" && isPlainObject(value)) {
    return Object.values(value).some(hasSeedPlaceholder);
  }
  return false;
}
