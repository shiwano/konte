import type { StateManager } from "./state/index.js";
import type { KonteState, VariantState } from "./types/index.js";
import { isReviewLeaf } from "./variant-lineage.js";

interface ChangedInput {
  assetPath: string;
  recorded: string;
  current: string | null;
}

export interface VariantStaleness {
  inputStale: boolean;
  definitionStale: boolean;
  /**
   * Of `definitionStale`, the half a patch variant owns: its patch script has been edited since it
   * was produced. `definitionStale` is set too.
   */
  patchStale: boolean;
  changedInputs: ChangedInput[];
}

export interface StaleVariant extends VariantStaleness {
  variantId: string;
}

/**
 * What an address's variants boil down to for resolution, independent of the caller's
 * options: the accepted take, else the newest non-stale take with a file, plus the newest
 * stale one for the `includeStale` fallback. Computing this is the expensive part — the
 * fallback scan recurses through every candidate's inputs — so it is what the memo stores.
 */
interface ResolveCore {
  acceptedId: string | null;
  newestFreshId: string | null;
  newestStaleId: string | null;
}

const CUTOFF_CORE: ResolveCore = { acceptedId: null, newestFreshId: null, newestStaleId: null };

/**
 * Memo shared across staleness queries over one unchanged state. Without it every query
 * re-explores the upstream cone, which is exponential on an unaccepted dependency chain
 * (a cross-shot chain). Any state mutation invalidates it — create one per read-only
 * pass and drop it on write; the exported functions create a per-call one when none is given.
 *
 * `definitions` rides along because the memo is only valid under the definitions it was computed
 * with — sharing one between a blind cache and a loaded one hands out the other's resolution.
 */
export function createStalenessCache(definitions?: ResolutionDefinitions) {
  return {
    resolved: new Map<string, ResolveCore>(),
    definitions,
    definitionHashes: new Map<string, string | null>(),
  };
}

export type StalenessCache = ReturnType<typeof createStalenessCache>;

/**
 * One resolution walk: the memo (per-call or caller-shared), the in-progress addresses that
 * end a cyclic recursion, and whether the current subtree's answer leaned on such a cutoff —
 * a path-dependent answer that must not be memoized, or a later query entering from another
 * root could read a resolution the render path would not pick.
 */
interface ResolveContext {
  memo: Map<string, ResolveCore>;
  visiting: Set<string>;
  sawCutoff: boolean;
  definitions: ResolutionDefinitions | undefined;
  definitionHashes: Map<string, string | null>;
}

function newContext(cache?: StalenessCache): ResolveContext {
  return {
    memo: cache?.resolved ?? new Map(),
    visiting: new Set(),
    sawCutoff: false,
    definitions: cache?.definitions,
    definitionHashes: cache?.definitionHashes ?? new Map(),
  };
}

/**
 * The current definition hash for an address inside a resolution walk, or null when the walk was
 * given no definitions — the definition axis is then skipped, as `currentDefinitionHash: null`
 * skips it for a single variant. Memoized per walk: hashing a composition walks its structure.
 */
function walkDefinitionHash(address: string, ctx: ResolveContext): string | null {
  if (!ctx.definitions) return null;
  const memoized = ctx.definitionHashes.get(address);
  if (memoized !== undefined) return memoized;
  const hash = ctx.definitions.definitionHash(address);
  ctx.definitionHashes.set(address, hash);
  return hash;
}

/**
 * The output hash an upstream address resolves to now — the pipeline's selection (`includeStale`
 * off), so "what I consumed" is compared against "what I would consume now". Null when nothing
 * resolves: not determinable, so not stale. Comparing against the accepted variant alone would
 * leave the unaccepted regime blind, where resolution falls through to the newest non-stale take.
 */
function resolvedOutputHash(
  state: KonteState,
  address: string,
  ctx: ResolveContext,
): string | null {
  const core = resolveCore(state, address, ctx);
  const variantId = core.acceptedId ?? core.newestFreshId;
  if (!variantId) return null;
  return state.assets[address]?.variants?.[variantId]?.outputHash ?? null;
}

/**
 * Current patch-definition hash per source variant id (`patches/<sourceVariantId>.ts`), as built
 * by `loadPatchCatalog`. Passed by callers that have loaded the patch scripts; omitting it simply
 * skips the patch axis, mirroring how `currentDefinitionHash: null` skips the definition axis.
 */
export type PatchHashes = ReadonlyMap<string, string>;

/**
 * What a resolution walk needs to judge a take's OWN definition rather than only its inputs: the
 * current definition hash for any address it reaches (null where there is no definition to compare
 * — a `file` asset, an address the definition no longer declares), plus the patch-script hashes for
 * a patch output.
 *
 * State holds no definition hash of its own, so without this every take reads as definition-fresh.
 * A command registers this for its video root once it has loaded the stage entries
 * (`applyResolutionDefinitions`); one that has not keeps the input axis alone.
 */
export interface ResolutionDefinitions {
  definitionHash: (address: string) => string | null;
  patchHashes?: PatchHashes;
  // Whether the address's asset produces the same output for the same inputs — see
  // `isDeterministicAddress`, which is what fills this in.
  isDeterministic: (address: string) => boolean;
}

// A patch variant's own definition is its patch script, so editing that script ages out the take
// it produced — exactly as editing animatic.tsx ages out a generated one. Its `definitionHash`
// meanwhile is inherited from its source, so the address-level axis still stales the whole lineage
// together. A script that is simply gone is an orphan for `prune`, not a stale variant.
function isPatchStale(variant: VariantState, patchHashes: PatchHashes | undefined): boolean {
  if (!patchHashes || variant.derivedFrom == null || variant.patchHash == null) return false;
  const current = patchHashes.get(variant.derivedFrom);
  return current !== undefined && current !== variant.patchHash;
}

/**
 * Content-addressed staleness for a single variant, derived from recorded hashes.
 * input-stale: a consumed input's recorded fingerprint no longer matches the output that
 * input's address resolves to now. definition-stale: the variant's own definition
 * (definitionHash, or for a patch variant its patch script) differs from the current one.
 *
 * A dependency path IS its upstream address (address ≡ asset path), so each recorded input
 * fingerprint is checked directly against that address's resolved output.
 */
export function computeVariantStaleness(
  state: KonteState,
  address: string,
  variant: VariantState,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): VariantStaleness {
  return computeVariantStalenessInternal(
    state,
    address,
    variant,
    currentDefinitionHash,
    patchHashes,
    newContext(cache),
  );
}

function computeVariantStalenessInternal(
  state: KonteState,
  _address: string,
  variant: VariantState,
  currentDefinitionHash: string | null,
  patchHashes: PatchHashes | undefined,
  ctx: ResolveContext,
): VariantStaleness {
  const changedInputs: ChangedInput[] = [];
  const kept = variant.status === "accepted" ? variant.keptInputs : undefined;

  for (const [depPath, made] of Object.entries(variant.inputFingerprints ?? {})) {
    const current = resolvedOutputHash(state, depPath, ctx);
    // A kept take is also current against what it was made from: an upstream switched back asks for
    // no second verdict.
    const recorded = kept?.[depPath] ?? made;
    if (current === null || current === recorded || current === made) continue;
    const via = parseKeptVia(recorded);
    if (via && resolvedMadeFrom(state, depPath, via, ctx)) continue;
    changedInputs.push({ assetPath: depPath, recorded, current });
  }

  const patchStale = isPatchStale(variant, patchHashes);
  const definitionStale =
    (currentDefinitionHash !== null &&
      variant.definitionHash !== null &&
      variant.definitionHash !== currentDefinitionHash) ||
    patchStale;

  return { inputStale: changedInputs.length > 0, definitionStale, patchStale, changedInputs };
}

const KEPT_VIA = "via:";

/**
 * The `keptInputs` value for an input reached through takes konte re-makes on its own — a
 * deterministic intermediate, a stem: kept against the upstream takes it is to be made from, since
 * its own hash is not known until it is.
 */
export function keptViaMarker(upstreams: Readonly<Record<string, string>>): string {
  return (
    KEPT_VIA +
    Object.keys(upstreams)
      .sort()
      .map((address) => `${address}=${upstreams[address]}`)
      .join(",")
  );
}

export function parseKeptVia(value: string): Record<string, string> | null {
  if (!value.startsWith(KEPT_VIA)) return null;
  const out: Record<string, string> = {};
  for (const pair of value.slice(KEPT_VIA.length).split(",")) {
    const at = pair.lastIndexOf("=");
    if (at <= 0) return null;
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

// Whether the take `address` resolves to was made, through the takes it consumed, from each of these
// upstream takes. Bounded: a chain of re-made intermediates is short.
function resolvedMadeFrom(
  state: KonteState,
  address: string,
  upstreams: Record<string, string>,
  ctx: ResolveContext,
): boolean {
  const core = resolveCore(state, address, ctx);
  const variantId = core.acceptedId ?? core.newestFreshId;
  const variant = variantId ? state.assets[address]?.variants?.[variantId] : undefined;
  if (!variant) return false;
  return Object.entries(upstreams).every(([root, hash]) => madeFrom(state, variant, root, hash, 8));
}

function madeFrom(
  state: KonteState,
  variant: VariantState,
  root: string,
  hash: string,
  depth: number,
): boolean {
  const recorded = variant.inputFingerprints?.[root];
  if (recorded !== undefined) return recorded === hash;
  if (depth === 0) return false;
  return Object.entries(variant.inputFingerprints ?? {}).some(([dep, depHash]) => {
    const consumed = Object.values(state.assets[dep]?.variants ?? {}).find(
      (v) => v.outputHash === depHash,
    );
    return consumed !== undefined && madeFrom(state, consumed, root, hash, depth - 1);
  });
}

export function isVariantStale(
  state: KonteState,
  address: string,
  variant: VariantState,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): boolean {
  return isVariantStaleInternal(
    state,
    address,
    variant,
    currentDefinitionHash,
    patchHashes,
    newContext(cache),
  );
}

function isVariantStaleInternal(
  state: KonteState,
  address: string,
  variant: VariantState,
  currentDefinitionHash: string | null,
  patchHashes: PatchHashes | undefined,
  ctx: ResolveContext,
): boolean {
  const s = computeVariantStalenessInternal(
    state,
    address,
    variant,
    currentDefinitionHash,
    patchHashes,
    ctx,
  );
  return s.inputStale || s.definitionStale;
}

/**
 * Variants ordered newest-first by `createdAt`. Same-instant ties (two variants
 * reserved in the same millisecond) fall back to later-inserted-is-newer.
 */
export function variantsNewestFirst(
  variants: Record<string, VariantState>,
): Array<[string, VariantState]> {
  return Object.entries(variants)
    .map(([id, v], index) => ({ id, v, index }))
    .sort((a, b) =>
      a.v.createdAt === b.v.createdAt ? b.index - a.index : a.v.createdAt < b.v.createdAt ? 1 : -1,
    )
    .map(({ id, v }) => [id, v]);
}

/**
 * The core resolution for an address, memoized. A HUMAN accepted take short-circuits (no
 * recursion, always cacheable) — it wins even when stale, because an accept is a decision to
 * protect. Otherwise the fallback scans newest-first for the first non-stale take, which
 * resolves this address's own inputs in turn.
 *
 * Non-stale on BOTH axes, so an older take whose definition still matches outranks a newer one
 * whose definition has moved. The definition axis needs the loaded definition, so it is live only
 * for a walk given one; see `ResolutionDefinitions`.
 *
 * A DETERMINISTIC accepted take only wins while it is non-stale: once its inputs move it is
 * ungenerated work — a `local` op the next `generate` re-bakes over its accept (`assetSkipReason`),
 * a stem the shot's re-accept re-materializes, a `#delivery` upscale the next export redoes — so a
 * stale one is nothing a build may consume. Not a patch output at such an address: its refresh is re-applying the
 * correction, which no stage generate does (`assetSkipReason` keeps it `accepted-stale`), so its
 * accept stands. Determinism is read off the definitions, so a walk given none keeps every human
 * accept.
 *
 * A fingerprint recorded under an older definition can name an address already being
 * resolved; answering the cutoff there ends the recursion. The guard sits here, not at the
 * caller, so an address resolves to the same variant however the resolution was entered —
 * staleness must never compare against a take the render path would not pick. A result
 * computed through such a cutoff is path-dependent and is returned without being memoized.
 */
function resolveCore(state: KonteState, address: string, ctx: ResolveContext): ResolveCore {
  const cached = ctx.memo.get(address);
  if (cached) return cached;

  const target = state.assets[address];
  if (!target?.variants) {
    ctx.memo.set(address, CUTOFF_CORE);
    return CUTOFF_CORE;
  }

  const acceptedEntry = Object.entries(target.variants).find(
    ([, v]) => v.status === "accepted" && v.file !== null,
  );
  if (
    acceptedEntry &&
    !(acceptedEntry[1].derivedFrom == null && ctx.definitions?.isDeterministic(address) === true)
  ) {
    const result: ResolveCore = {
      acceptedId: acceptedEntry[0],
      newestFreshId: null,
      newestStaleId: null,
    };
    ctx.memo.set(address, result);
    return result;
  }

  if (ctx.visiting.has(address)) {
    ctx.sawCutoff = true;
    return CUTOFF_CORE;
  }
  ctx.visiting.add(address);
  const outerSawCutoff = ctx.sawCutoff;
  ctx.sawCutoff = false;
  try {
    // A deterministic take's accept, still fresh: it is what every consumer records,
    // so keep reporting it as the accepted resolution rather than letting the scan below re-find it
    // as a plain take.
    if (
      acceptedEntry &&
      !isVariantStaleInternal(
        state,
        address,
        acceptedEntry[1],
        walkDefinitionHash(address, ctx),
        ctx.definitions?.patchHashes,
        ctx,
      )
    ) {
      const result: ResolveCore = {
        acceptedId: acceptedEntry[0],
        newestFreshId: null,
        newestStaleId: null,
      };
      if (!ctx.sawCutoff) ctx.memo.set(address, result);
      return result;
    }
    let newestFreshId: string | null = null;
    let newestStaleId: string | null = null;
    for (const [variantId, v] of variantsNewestFirst(target.variants)) {
      if (!v?.file) continue;
      // Resolving one would feed a downstream generate the very picture the reviewer refused.
      if (v.status === "dismissed") continue;
      if (
        isVariantStaleInternal(
          state,
          address,
          v,
          walkDefinitionHash(address, ctx),
          ctx.definitions?.patchHashes,
          ctx,
        )
      ) {
        newestStaleId ??= variantId;
        continue;
      }
      newestFreshId = variantId;
      break;
    }
    const result: ResolveCore = { acceptedId: null, newestFreshId, newestStaleId };
    if (!ctx.sawCutoff) ctx.memo.set(address, result);
    return result;
  } finally {
    ctx.sawCutoff ||= outerSawCutoff;
    ctx.visiting.delete(address);
  }
}

/**
 * The variant an address resolves to: the accepted one if any, otherwise the newest non-stale
 * variant with a file. "Newest" is by `createdAt`, not insertion order.
 *
 * `includeStale` picks which of the two questions this answers:
 *
 * - With it — "what does this address name right now": accepted, else newest non-stale, else the
 *   newest stale one. This is what every surface a human reads takes — `konte ref`, the review
 *   pages, `probe`, an address passed to `accept`/`patch new`.
 * - Without it — "what may a spend build on": a stale take answers nothing. This is the pipeline's
 *   question, asked by the job scheduler and the composition materializer so neither builds on
 *   material a regeneration is about to replace, and by staleness itself so a recorded fingerprint
 *   is compared against the take generation would consume now.
 *
 * State-pure counterpart of `StateManager.resolveReference` — both must agree.
 */
export function selectResolvedVariant(
  state: KonteState,
  address: string,
  options?: { includeStale?: boolean; requireAccepted?: boolean },
  cache?: StalenessCache,
): { variantId: string; isAccepted: boolean } | null {
  return selectResolvedVariantInternal(state, address, options, newContext(cache));
}

function selectResolvedVariantInternal(
  state: KonteState,
  address: string,
  options: { includeStale?: boolean; requireAccepted?: boolean } | undefined,
  ctx: ResolveContext,
): { variantId: string; isAccepted: boolean } | null {
  // requireAccepted never needs the fallback scan — keep it O(variants). Only a take `generate`
  // would redo over its accept costs a recursion: an accept that will not survive the next generate
  // is not one a spend may build on.
  //
  // Those are the re-bakes rather than skips as `accepted-stale`: a DETERMINISTIC accept — a `local`
  // op `generate` remakes, or the board's stem, which the shot's re-accept re-mixes; a stale one let
  // through spends video motion on the voice take the reviewer dropped. A patch output is neither: its refresh is the patch pass's, so its accept is kept (see
  // `resolveCore`).
  if (options?.requireAccepted) {
    const variants = state.assets[address]?.variants;
    if (!variants) return null;
    for (const [variantId, v] of Object.entries(variants)) {
      if (v.status !== "accepted" || v.file === null) continue;
      const rebakes = v.derivedFrom == null && ctx.definitions?.isDeterministic(address) === true;
      if (
        rebakes &&
        isVariantStaleInternal(
          state,
          address,
          v,
          walkDefinitionHash(address, ctx),
          ctx.definitions?.patchHashes,
          ctx,
        )
      )
        return null;
      return { variantId, isAccepted: true };
    }
    return null;
  }

  const core = resolveCore(state, address, ctx);
  if (core.acceptedId) return { variantId: core.acceptedId, isAccepted: true };
  if (core.newestFreshId) return { variantId: core.newestFreshId, isAccepted: false };
  if (options?.includeStale && core.newestStaleId) {
    return { variantId: core.newestStaleId, isAccepted: false };
  }
  return null;
}

/**
 * An undecided take standing beside the accepted one — a reroll or a patch output that is ready and
 * non-stale while the accepted variant stays the resolved/shown (and downstream-consumed) one.
 * Returns the newest such take's id, or null when nothing is accepted or every rival is settled.
 *
 * The verdict is read from `status` alone (see `VariantStatusSchema`), with no comparison of when
 * a take landed against when the accept was made.
 *
 * A variant that has been patched is not a candidate — it is the "before" of its correction.
 *
 * Single source of truth behind the preview UI's `hasNewerVariant`, `status`'s staleAwaitingAccept,
 * and the generate/reroll upstream warning.
 */
export function undecidedTakeBesideAccepted(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null = null,
  excludeVariantIds?: ReadonlySet<string>,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): string | null {
  const accepted = Object.values(state.assets[address]?.variants ?? {}).some(
    (v) => v.status === "accepted" && v.file !== null,
  );
  if (!accepted) return null;
  return newestReadyUndecidedTake(
    state,
    address,
    currentDefinitionHash,
    excludeVariantIds,
    patchHashes,
    cache,
  );
}

/**
 * The newest take at an address still awaiting a verdict and non-stale on both axes — the way out
 * of a stale take that costs no spend, and what a reverted edit hands the address back to.
 *
 * Reads the same candidates as `readyUndecidedTakes`, so a dismissed take and a patched-off one are
 * out. An accepted match is out too — it would already be what the address resolves to.
 */
export function newestReadyUndecidedTake(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null = null,
  excludeVariantIds?: ReadonlySet<string>,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): string | null {
  const variants = state.assets[address]?.variants;
  if (!variants) return null;
  const readyOf = (v: VariantState) => v.readyAt ?? v.createdAt;
  const candidates = readyUndecidedTakes(
    state,
    address,
    currentDefinitionHash,
    excludeVariantIds,
    patchHashes,
    cache,
  );
  let newest: string | null = null;
  let newestAt = "";
  for (const variantId of candidates) {
    const at = readyOf(variants[variantId] as VariantState);
    if (newest === null || at > newestAt) {
      newest = variantId;
      newestAt = at;
    }
  }
  return newest;
}

/**
 * Every take at an address still awaiting a verdict: undecided (`status === "none"`), holding a
 * file, a lineage leaf, and non-stale on both axes. These are the candidates a review is deciding
 * among — what an accept dismisses the rest of, and what `status` counts as review work.
 */
export function readyUndecidedTakes(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null = null,
  excludeVariantIds?: ReadonlySet<string>,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): string[] {
  const variants = state.assets[address]?.variants;
  if (!variants) return [];
  const ctx = newContext(cache);
  const ready: string[] = [];
  for (const [variantId, v] of Object.entries(variants)) {
    if (!v.file || v.status !== "none") continue;
    if (excludeVariantIds?.has(variantId)) continue;
    if (!isReviewLeaf(state, address, variantId)) continue;
    if (isVariantStaleInternal(state, address, v, currentDefinitionHash, patchHashes, ctx))
      continue;
    ready.push(variantId);
  }
  return ready;
}

export interface UndecidedUpstreamTake {
  depPath: string;
  address: string;
  acceptedVariantId: string;
  undecidedVariantId: string;
}

/**
 * For each dependency, the upstream whose accepted variant a downstream generate/reroll
 * will resolve while a ready, non-stale take sits undecided beside it — the silent case
 * where the downstream builds on the accepted frame after an upstream reroll. The undecided
 * take is the newest of those, which is not necessarily newer than the accept. Empty when
 * every upstream's rivals are settled (or none is accepted). A dependency path IS the
 * upstream address.
 */
export function collectUndecidedUpstreamTakes(
  state: KonteState,
  depPaths: readonly string[],
  cache?: StalenessCache,
): UndecidedUpstreamTake[] {
  const takes: UndecidedUpstreamTake[] = [];
  const seen = new Set<string>();
  const sharedCache = cache ?? createStalenessCache();
  for (const depPath of depPaths) {
    const address = depPath;
    if (seen.has(address)) continue;
    seen.add(address);
    const undecidedVariantId = undecidedTakeBesideAccepted(
      state,
      address,
      // Off the cache's own definitions: a rival whose definition has moved is not one to accept.
      sharedCache.definitions?.definitionHash(address) ?? null,
      undefined,
      sharedCache.definitions?.patchHashes,
      sharedCache,
    );
    if (!undecidedVariantId) continue;
    const acceptedVariantId = Object.entries(state.assets[address]?.variants ?? {}).find(
      ([, v]) => v.status === "accepted",
    )?.[0];
    if (!acceptedVariantId) continue;
    takes.push({ depPath, address, acceptedVariantId, undecidedVariantId });
  }
  return takes;
}

/**
 * Accepted variants of `address` that are currently stale, with the reason.
 * Used by both `status` and `inspect` to surface why-stale uniformly.
 */
export function collectStaleVariants(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): StaleVariant[] {
  const variants = state.assets[address]?.variants ?? {};
  const ctx = newContext(cache);
  const result: StaleVariant[] = [];
  for (const [variantId, v] of Object.entries(variants)) {
    if (v.status !== "accepted") continue;
    const s = computeVariantStalenessInternal(
      state,
      address,
      v,
      currentDefinitionHash,
      patchHashes,
      ctx,
    );
    if (s.inputStale || s.definitionStale) {
      result.push({ variantId, ...s });
    }
  }
  return result;
}

/**
 * Unaccepted variants of `address` that are currently stale, newest-first — takes nobody signed off
 * and that no longer match what their inputs or definition say. Not `collectStaleVariants`, which
 * is accepted takes, whose refresh is a `reroll`; these are work the next `generate` redoes.
 */
export function collectStaleUnacceptedVariants(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): StaleVariant[] {
  const variants = state.assets[address]?.variants ?? {};
  const ctx = newContext(cache);
  const result: StaleVariant[] = [];
  for (const [variantId, v] of variantsNewestFirst(variants)) {
    // Undecided takes only. A dismissed one is settled work whatever its staleness, and `status`
    // says so on its own terms rather than reporting it as a take the next generate will replace.
    if (v.status !== "none" || !v.file) continue;
    const s = computeVariantStalenessInternal(
      state,
      address,
      v,
      currentDefinitionHash,
      patchHashes,
      ctx,
    );
    if (s.inputStale || s.definitionStale) {
      result.push({ variantId, ...s });
    }
  }
  return result;
}

/**
 * Staleness of the take `address` resolves to on a read surface (`includeStale`), or null when
 * nothing resolves. A dismissed or superseded take never counts.
 */
export function resolvedStaleness(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null,
  patchHashes?: PatchHashes,
  cache?: StalenessCache,
): StaleVariant | null {
  const ctx = newContext(cache);
  const resolved = selectResolvedVariantInternal(state, address, { includeStale: true }, ctx);
  const v = resolved ? state.assets[address]?.variants?.[resolved.variantId] : undefined;
  if (!resolved || !v) return null;
  return {
    variantId: resolved.variantId,
    ...computeVariantStalenessInternal(state, address, v, currentDefinitionHash, patchHashes, ctx),
  };
}

/** Compact one-line stale reason, e.g. `stale (input-stale: a, b; definition-stale)`. */
// Why the variant is stale, with no "stale" of its own — for a caller whose surrounding context
// (a section title, a column header) already says it. Empty when neither axis is set.
export function formatStaleCause(sv: VariantStaleness): string {
  const parts: string[] = [];
  if (sv.inputStale) {
    const inputs = sv.changedInputs.map((ci) => ci.assetPath).join(", ");
    parts.push(inputs ? `input-stale: ${inputs}` : "input-stale");
  }
  // A patch variant's `definitionHash` is inherited from its source, so "definition-stale" would
  // point at an address definition that has not moved.
  if (sv.patchStale) {
    parts.push("patch-stale");
  } else if (sv.definitionStale) {
    parts.push("definition-stale");
  }
  return parts.join("; ");
}

export function formatStaleReason(sv: VariantStaleness): string {
  const cause = formatStaleCause(sv);
  return cause ? `stale (${cause})` : "stale";
}

interface AcceptedStaleness extends VariantStaleness {
  variantId: string | null;
}

/**
 * Staleness of the asset's accepted variant. Returns variantId: null (and false
 * flags) when nothing is accepted.
 */
export function computeAcceptedStaleness(
  state: KonteState,
  address: string,
  currentDefinitionHash: string | null,
  cache?: StalenessCache,
): AcceptedStaleness {
  const target = state.assets[address];
  if (target?.variants) {
    for (const [variantId, v] of Object.entries(target.variants)) {
      if (v.status === "accepted") {
        return {
          variantId,
          ...computeVariantStaleness(state, address, v, currentDefinitionHash, undefined, cache),
        };
      }
    }
  }
  return {
    variantId: null,
    inputStale: false,
    definitionStale: false,
    patchStale: false,
    changedInputs: [],
  };
}

// Takes a manager rather than bare state so the walk gets its definitions by default — the accepted
// take's inputs are judged against what each RESOLVES to.
export function isAcceptedStale(
  manager: StateManager,
  address: string,
  currentDefinitionHash: string | null = null,
  cache?: StalenessCache,
): boolean {
  const s = computeAcceptedStaleness(
    manager.getState(),
    address,
    currentDefinitionHash,
    cache ?? manager.stalenessCache(),
  );
  return s.inputStale || s.definitionStale;
}

/**
 * Transitive downstream addresses whose accepted variant is now input-stale,
 * given the current state. Walks the dependents graph from `address`. Used to
 * surface "what this accept/reject made stale" without storing flags.
 *
 * The dependents graph is keyed by asset path, which is the address (address ≡ asset path),
 * so each reached path is a concrete address — no per-profile reconstruction.
 */
export function collectStaleDependents(
  state: KonteState,
  address: string,
  dependents: ReadonlyMap<string, readonly string[]>,
  cache?: StalenessCache,
): string[] {
  const marked = new Set<string>();
  const visited = new Set<string>();
  const ctx = newContext(cache);
  const queue = [...(dependents.get(address) ?? [])];

  while (queue.length > 0) {
    const currentAddr = queue.shift() as string;
    if (visited.has(currentAddr)) continue;
    visited.add(currentAddr);

    const variants = state.assets[currentAddr]?.variants ?? {};
    const anyInputStale = Object.values(variants).some(
      (v) =>
        computeVariantStalenessInternal(state, currentAddr, v, null, undefined, ctx).inputStale,
    );
    if (anyInputStale) {
      marked.add(currentAddr);
    }

    for (const next of dependents.get(currentAddr) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return [...marked];
}
