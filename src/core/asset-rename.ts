import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addressToCacheSegments, deliveryAddressOf, parseAddress } from "./address.js";
import { definitionHashForAddress } from "./composition-resource.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { readDefinitionSnapshot, writeDefinitionSnapshot } from "./definition-snapshot.js";
import { definitionForAddress, type StageDefinitions } from "./definition-hashes.js";
import { makeAddressPlaceholder } from "./dsl/shot-context.js";
import { computePatchHash, listPatchVariantIds, loadPatch, patchAssetAddress } from "./patch.js";
import type { AssetDefinition, JobRecord, KonteState } from "./types/index.js";
import { assetDir } from "./variant-dir.js";

/** `from` → `to`, and the same for their `#delivery` derivatives where the address has one. */
export function renameMoves(from: string, to: string): Map<string, string> {
  const moves = new Map([[from, to]]);
  const { kind } = parseAddress(from);
  if (kind === "shot" || kind === "timeline") {
    moves.set(deliveryAddressOf(from), deliveryAddressOf(to));
  }
  return moves;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `value` with every mention of a moved address renamed: a placeholder anywhere in a string, or a
 * string or object key that is the bare address. Plain objects and arrays are copied; anything else is kept.
 */
export function renameAddressText(value: unknown, moves: ReadonlyMap<string, string>): unknown {
  const placeholders = new Map(
    [...moves].map(([from, to]) => [makeAddressPlaceholder(from), makeAddressPlaceholder(to)]),
  );
  const placeholder = new RegExp(
    `(?:${[...placeholders.keys()].map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`,
    "g",
  );
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const bare = moves.get(v);
      if (bare !== undefined) return bare;
      return v.replace(placeholder, (match) => placeholders.get(match)!);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [moves.get(k) ?? k, walk(inner)]),
      );
    }
    return v;
  };
  return walk(value);
}

function invert(moves: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...moves].map(([from, to]) => [to, from]));
}

/**
 * Maps a definition hash recorded before the rename to the one the live definitions give, when the
 * rename is all that moved it: the live definition with the new names put back to the old hashes to
 * `recorded`. Any other hash is returned as it is.
 */
export function createHashCarrier(
  definitions: StageDefinitions,
  moves: ReadonlyMap<string, string>,
): (address: string, recorded: string) => string {
  const back = invert(moves);
  const unrename = (input: unknown) => renameAddressText(input, back);
  return (address, recorded) => {
    const definition = definitionForAddress(definitions, address);
    if (!definition) return recorded;
    const live = definitionHashForAddress(definition, address);
    if (live === null || live === recorded) return recorded;
    return definitionHashForAddress(definition, address, unrename) === recorded ? live : recorded;
  };
}

/**
 * Carries every take's definition hash over a rename of what it consumes (see `createHashCarrier`),
 * rewriting the definition snapshot beside each carried take. Returns the addresses carried.
 */
export function carryDefinitionHashes(
  videoRoot: string,
  state: KonteState,
  carry: (address: string, recorded: string) => string,
  moves: ReadonlyMap<string, string>,
): string[] {
  const carried = new Set<string>();
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(asset.variants ?? {})) {
      if (variant.definitionHash === null) continue;
      const next = carry(address, variant.definitionHash);
      if (next === variant.definitionHash) continue;
      variant.definitionHash = next;
      carried.add(address);
      const snapshot = readDefinitionSnapshot(videoRoot, address, variantId);
      if (snapshot) {
        writeDefinitionSnapshot(
          videoRoot,
          address,
          variantId,
          renameAddressText(snapshot, moves) as typeof snapshot,
        );
      }
    }
  }
  return [...carried];
}

/**
 * Carries every patch the rename touches over it — one on a moved take, or one whose chain consumes
 * a moved address: a patched take's `patchHash` and each chain step's `definitionHash`, where the
 * rename is all that moved them. A patch on a moved take that will not load fails the rename; any
 * other is left as it is. Returns the patch steps carried.
 */
export async function carryPatchHashes(
  videoRoot: string,
  state: KonteState,
  moves: ReadonlyMap<string, string>,
): Promise<string[]> {
  const back = invert(moves);
  const unrename = (def: AssetDefinition) => renameAddressText(def, back) as AssetDefinition;
  const moved = new Set(moves.values());
  const sourceAddress = new Map<string, string>();
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const variantId of Object.keys(asset.variants ?? {}))
      sourceAddress.set(variantId, address);
  }
  const carried: string[] = [];
  for (const sourceVariantId of await listPatchVariantIds(videoRoot)) {
    const address = sourceAddress.get(sourceVariantId);
    if (address === undefined) continue;
    const variants = state.assets[address]?.variants ?? {};
    const patch = await loadPatch(videoRoot, state, sourceVariantId).catch((err: unknown) => {
      if (moved.has(address)) throw err;
      return null;
    });
    if (!patch) continue;
    const before = computePatchHash({
      ...patch,
      assets: Object.fromEntries(
        Object.entries(patch.assets).map(([name, def]) => [name, unrename(def)]),
      ),
    });
    if (before !== patch.patchHash) {
      for (const variant of Object.values(variants)) {
        if (variant.derivedFrom === sourceVariantId && variant.patchHash === before) {
          variant.patchHash = patch.patchHash;
        }
      }
    }
    for (const [name, def] of Object.entries(patch.assets)) {
      const live = computeDefinitionHash(def);
      const recorded = computeDefinitionHash(unrename(def));
      if (live === recorded) continue;
      const stepAddress = patchAssetAddress(patch, name);
      for (const [variantId, variant] of Object.entries(
        state.assets[stepAddress]?.variants ?? {},
      )) {
        if (variant.definitionHash !== recorded) continue;
        variant.definitionHash = live;
        const snapshot = readDefinitionSnapshot(videoRoot, stepAddress, variantId);
        if (snapshot) {
          writeDefinitionSnapshot(
            videoRoot,
            stepAddress,
            variantId,
            renameAddressText(snapshot, moves) as AssetDefinition,
          );
        }
        if (!carried.includes(stepAddress)) carried.push(stepAddress);
      }
    }
  }
  return carried;
}

/**
 * A finished job with every moved address in it renamed and every file under one repointed, or
 * null when it names none.
 */
export function renameJob(
  job: JobRecord,
  moves: ReadonlyMap<string, string>,
  moveFile: (file: string) => string,
): JobRecord | null {
  const rename = (address: string) => moves.get(address) ?? address;
  if (job.kind === "song-analysis") {
    return moves.has(job.address) ? { ...job, address: rename(job.address) } : null;
  }
  if (job.kind !== "generation") return null;
  const { resolvedDependencies, compositionCacheKeys } = job.provenance;
  const files = [...job.outputFiles, ...Object.values(resolvedDependencies)];
  const touched =
    [job.address, ...job.dependsOnAssets, ...Object.keys(resolvedDependencies)].some((a) =>
      moves.has(a),
    ) || files.some((file) => moveFile(file) !== file);
  if (!touched) return null;
  return {
    ...job,
    address: rename(job.address),
    dependsOnAssets: job.dependsOnAssets.map(rename),
    outputFiles: job.outputFiles.map(moveFile),
    provenance: {
      ...job.provenance,
      resolvedDependencies: Object.fromEntries(
        Object.entries(resolvedDependencies).map(([a, file]) => [rename(a), moveFile(file)]),
      ),
      compositionCacheKeys: Object.fromEntries(
        Object.entries(compositionCacheKeys).map(([a, key]) => [rename(a), key]),
      ),
    },
  };
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Moves each moved address's directory under `assets/` and its thumbnail cache, returning what puts
 * them back. A failure puts back the directories already moved.
 */
export async function moveAssetDirs(
  videoRoot: string,
  moves: ReadonlyMap<string, string>,
): Promise<() => Promise<void>> {
  const thumbnails = (address: string) =>
    path.join(videoRoot, ".konte", "cache", "thumbnails", ...addressToCacheSegments(address));
  const pairs: Array<[string, string]> = [];
  for (const [from, to] of moves) {
    pairs.push([assetDir(videoRoot, from), assetDir(videoRoot, to)]);
    pairs.push([thumbnails(from), thumbnails(to)]);
  }
  const done: Array<[string, string]> = [];
  const undo = async () => {
    for (const [src, dest] of done.reverse()) await fs.rename(dest, src).catch(() => {});
  };
  try {
    for (const [src, dest] of pairs) {
      if (!(await exists(src))) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      done.push([src, dest]);
    }
  } catch (err) {
    await undo();
    throw err;
  }
  return undo;
}

/** A variant's `file` under a moved address's directory, repointed into the new one. */
export function createFileMover(moves: ReadonlyMap<string, string>): (file: string) => string {
  const prefixes = [...moves].map(([from, to]) => [
    `${assetDir("", from)}${path.sep}`,
    `${assetDir("", to)}${path.sep}`,
  ]);
  return (file) => {
    const normalized = path.join(file);
    for (const [from, to] of prefixes) {
      if (normalized.startsWith(from!)) return `${to}${normalized.slice(from!.length)}`;
    }
    return file;
  };
}
