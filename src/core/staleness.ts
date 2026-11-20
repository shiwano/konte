import { acceptedVariant, acceptedVariantId } from "./accepted-variant.js";
import type { KonteState, VariantState } from "./types/index.js";
import { variantOwningFile } from "./variant-dir.js";
import { isReviewLeaf } from "./variant-lineage.js";

interface ChangedInput {
  address: string;
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
 * One resolution walk: the view's memo, the in-progress addresses that end a cyclic recursion, and
 * whether the current subtree's answer leaned on such a cutoff — a path-dependent answer that must
 * not be memoized, or a later query entering from another root could read a resolution the render
 * path would not pick.
 */
interface ResolveContext {
  memo: Map<string, ResolveCore>;
  visiting: Set<string>;
  sawCutoff: boolean;
  definitions: ResolutionDefinitions | undefined;
  definitionHashes: Map<string, string | null>;
  chainInputs: Map<string, ReadonlySet<string>>;
}

/**
 * The current definition hash for an address inside a resolution walk, or null when the walk was
 * given no definitions — the definition axis is then skipped. Memoized per view: hashing a
 * composition walks its structure.
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
 * by `loadPatchCatalog`. Without it the patch axis is not read.
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
  // Whether a take's definition moved only under its adapter — see `isAdapterDrift`.
  adapterDrift?: (state: KonteState, address: string, variantId: string) => boolean;
}

/** Whether `generate` re-bakes an accepted `variant`: an unpatched take of a deterministic asset. */
export function rebakesOverAccept(
  variant: Pick<VariantState, "derivedFrom">,
  deterministic: boolean,
): boolean {
  return variant.derivedFrom == null && deterministic;
}

// A patch variant's own definition is its patch script, so editing that script ages out the take
// it produced — exactly as editing animatic.tsx ages out a generated one. Its `definitionHash`
// meanwhile is inherited from its source, so the address-level axis still stales the whole lineage
// together. A script that is simply gone is an orphan for `clean`, not a stale variant.
function isPatchStale(variant: VariantState, patchHashes: PatchHashes | undefined): boolean {
  if (!patchHashes || variant.derivedFrom == null || variant.patchHash == null) return false;
  const current = patchHashes.get(variant.derivedFrom);
  return current !== undefined && current !== variant.patchHash;
}

function isDeterministicIn(ctx: ResolveContext, address: string): boolean {
  return ctx.definitions?.isDeterministic(address) === true;
}

// The source of a patch output while its accept stands; the output's inherited axes are its.
function standingAcceptedSource(
  state: KonteState,
  address: string,
  variant: VariantState,
  ctx: ResolveContext,
): VariantState | null {
  if (variant.derivedFrom == null) return null;
  const source = state.assets[address]?.variants?.[variant.derivedFrom];
  if (source?.status !== "accepted" || !source.file) return null;
  if (rebakesOverAccept(source, isDeterministicIn(ctx, address))) return null;
  return source;
}

// The upstreams a patch output's chain consumed itself: its returned step's.
function chainInputsOf(
  state: KonteState,
  address: string,
  file: string,
  ctx: ResolveContext,
): ReadonlySet<string> {
  const memoized = ctx.chainInputs.get(file);
  if (memoized) return memoized;
  const step = variantOwningFile(state, file);
  const fingerprints = step
    ? state.assets[step.address]?.variants?.[step.variantId]?.inputFingerprints
    : undefined;
  const inputs = new Set(Object.keys(fingerprints ?? {}));
  inputs.delete(address);
  ctx.chainInputs.set(file, inputs);
  return inputs;
}

function computeVariantStalenessInternal(
  state: KonteState,
  address: string,
  variant: VariantState,
  currentDefinitionHash: string | null,
  patchHashes: PatchHashes | undefined,
  ctx: ResolveContext,
): VariantStaleness {
  const changedInputs: ChangedInput[] = [];
  const kept = variant.status === "accepted" ? variant.keptInputs : undefined;
  const keptSource = standingAcceptedSource(state, address, variant, ctx);
  const chainInputs =
    keptSource && variant.file ? chainInputsOf(state, address, variant.file, ctx) : null;

  for (const [depPath, made] of Object.entries(variant.inputFingerprints ?? {})) {
    if (
      keptSource &&
      !chainInputs?.has(depPath) &&
      (made === keptSource.inputFingerprints?.[depPath] ||
        made === keptSource.keptInputs?.[depPath])
    )
      continue;
    const current = resolvedOutputHash(state, depPath, ctx);
    // A kept take is also current against what it was made from: an upstream switched back asks for
    // no second verdict.
    const recorded = kept?.[depPath] ?? made;
    if (current === null || current === recorded || current === made) continue;
    const via = parseKeptVia(recorded);
    if (via && resolvedMadeFrom(state, depPath, via, ctx)) continue;
    changedInputs.push({ address: depPath, recorded, current });
  }

  const patchStale = isPatchStale(variant, patchHashes);
  const definitionStale =
    (currentDefinitionHash !== null &&
      !keptSource &&
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
 * for a walk given one; see `ResolutionDefinitions`. The patch axis is not read: a correction whose
 * script was edited keeps resolving until its re-apply lands, never handing the address back to
 * the take it corrected.
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

  const found = acceptedVariant(state, address);
  const accepted = found?.variant.file != null ? found : null;
  if (accepted && !rebakesOverAccept(accepted.variant, isDeterministicIn(ctx, address))) {
    const result: ResolveCore = {
      acceptedId: accepted.variantId,
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
      accepted &&
      !isVariantStaleInternal(
        state,
        address,
        accepted.variant,
        walkDefinitionHash(address, ctx),
        undefined,
        ctx,
      )
    ) {
      const result: ResolveCore = {
        acceptedId: accepted.variantId,
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
        isVariantStaleInternal(state, address, v, walkDefinitionHash(address, ctx), undefined, ctx)
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
      if (
        rebakesOverAccept(v, isDeterministicIn(ctx, address)) &&
        isVariantStaleInternal(state, address, v, walkDefinitionHash(address, ctx), undefined, ctx)
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

/** Compact one-line stale reason, e.g. `stale (input-stale: a, b; definition-stale)`. */
// Why the variant is stale, with no "stale" of its own — for a caller whose surrounding context
// (a section title, a column header) already says it. Empty when neither axis is set.
export function formatStaleCause(sv: VariantStaleness): string {
  const parts: string[] = [];
  if (sv.inputStale) {
    const inputs = sv.changedInputs.map((ci) => ci.address).join(", ");
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

export interface AcceptedStaleness extends VariantStaleness {
  variantId: string | null;
}

/** Which axes a staleness question reads beyond inputs and the definition. */
interface StalenessAxes {
  // False leaves a patch output's own script out: its refresh is the patch pass's.
  patch?: boolean;
}

/**
 * Staleness and resolution over one state, judged under one set of definitions: each address's
 * definition hash and the patch hashes are read from `definitions`. Without definitions only the
 * input axis is read and no asset is deterministic.
 *
 * The memo is what keeps a pass linear — without it every query re-explores the upstream cone,
 * exponential on an unaccepted cross-shot chain. It is valid only while `state` is unchanged: make
 * one per read-only pass and drop it on any write.
 */
export class StalenessView {
  private readonly memo = new Map<string, ResolveCore>();
  private readonly definitionHashes = new Map<string, string | null>();
  private readonly chainInputs = new Map<string, ReadonlySet<string>>();

  constructor(
    readonly state: KonteState,
    readonly definitions: ResolutionDefinitions | undefined,
  ) {}

  private walk(): ResolveContext {
    return {
      memo: this.memo,
      visiting: new Set(),
      sawCutoff: false,
      definitions: this.definitions,
      definitionHashes: this.definitionHashes,
      chainInputs: this.chainInputs,
    };
  }

  /** The current definition hash of `address`, null where the definitions have none to compare. */
  definitionHash(address: string): string | null {
    return walkDefinitionHash(address, this.walk());
  }

  get patchHashes(): PatchHashes | undefined {
    return this.definitions?.patchHashes;
  }

  isDeterministic(address: string): boolean {
    return isDeterministicIn(this.walk(), address);
  }

  /**
   * The variant an address resolves to: the accepted one if any, otherwise the newest non-stale
   * variant with a file, newest by `variantsNewestFirst`.
   *
   * `includeStale` picks which of the two questions this answers:
   *
   * - With it — "what does this address name right now": accepted, else newest non-stale, else the
   *   newest stale one. This is what every surface a human reads takes — `konte path`, the review
   *   pages, `probe`, an address passed to `accept`/`patch new`.
   * - Without it — "what may a spend build on": a stale take answers nothing. This is the
   *   pipeline's question, asked by the job scheduler and the composition materializer so neither
   *   builds on material a regeneration is about to replace, and by staleness itself so a recorded
   *   fingerprint is compared against the take generation would consume now.
   */
  resolve(
    address: string,
    options?: { includeStale?: boolean; requireAccepted?: boolean },
  ): { variantId: string; isAccepted: boolean } | null {
    return selectResolvedVariantInternal(this.state, address, options, this.walk());
  }

  /**
   * How `variant` at `address` stands. input-stale: a consumed input's recorded fingerprint no
   * longer matches the output that input's address resolves to now. definition-stale: the
   * variant's own definition (definitionHash, or for a patch variant its patch script) differs
   * from the current one.
   */
  staleness(address: string, variant: VariantState, axes?: StalenessAxes): VariantStaleness {
    const ctx = this.walk();
    return computeVariantStalenessInternal(
      this.state,
      address,
      variant,
      walkDefinitionHash(address, ctx),
      axes?.patch === false ? undefined : this.patchHashes,
      ctx,
    );
  }

  isStale(address: string, variant: VariantState, axes?: StalenessAxes): boolean {
    const s = this.staleness(address, variant, axes);
    return s.inputStale || s.definitionStale;
  }

  /**
   * `staleness` with the address's definition left unread, against the given patch hashes — for a
   * patch pass.
   */
  stalenessWithoutDefinition(
    address: string,
    variant: VariantState,
    patchHashes: PatchHashes | undefined,
  ): VariantStaleness {
    return computeVariantStalenessInternal(
      this.state,
      address,
      variant,
      null,
      patchHashes,
      this.walk(),
    );
  }

  /**
   * `staleness` of a take at a patch chain step, whose definition is the step in its patch script —
   * which the registered definitions do not carry.
   */
  patchStepStaleness(
    address: string,
    variant: VariantState,
    stepDefinitionHash: string,
  ): VariantStaleness {
    return computeVariantStalenessInternal(
      this.state,
      address,
      variant,
      stepDefinitionHash,
      undefined,
      this.walk(),
    );
  }

  /**
   * Staleness of the take `address` resolves to on a read surface (`includeStale`), or null when
   * nothing resolves. A dismissed or superseded take never counts.
   */
  resolvedStaleness(address: string): StaleVariant | null {
    const resolved = this.resolve(address, { includeStale: true });
    const v = resolved ? this.state.assets[address]?.variants?.[resolved.variantId] : undefined;
    if (!resolved || !v) return null;
    return { variantId: resolved.variantId, ...this.staleness(address, v) };
  }

  /**
   * Staleness of the asset's accepted variant; variantId null (and false flags) when nothing is
   * accepted. The patch axis is not read: an accepted correction stands until its re-apply lands.
   */
  acceptedStaleness(address: string): AcceptedStaleness {
    const accepted = acceptedVariant(this.state, address);
    if (accepted) {
      return {
        variantId: accepted.variantId,
        ...this.staleness(address, accepted.variant, { patch: false }),
      };
    }
    return {
      variantId: null,
      inputStale: false,
      definitionStale: false,
      patchStale: false,
      changedInputs: [],
    };
  }

  isAcceptedStale(address: string): boolean {
    const s = this.acceptedStaleness(address);
    return s.inputStale || s.definitionStale;
  }

  /**
   * Whether the take accepted at `address` was drawn from the current definition, or from one that
   * moved only under its adapter.
   */
  acceptedAsDefined(address: string): boolean {
    const accepted = this.acceptedStaleness(address);
    if (accepted.variantId === null) return false;
    if (!accepted.definitionStale) return true;
    return this.definitions?.adapterDrift?.(this.state, address, accepted.variantId) === true;
  }

  /**
   * Every take at `address` awaiting a verdict: undecided (`status === "none"`), holding a file, a
   * lineage leaf, and non-stale on every axis — newest first, in the order resolution reads them.
   * These are the candidates a review is deciding among, what an accept dismisses the rest of, and
   * what `status` counts as review work.
   */
  readyUndecided(address: string, exclude?: ReadonlySet<string>): string[] {
    const variants = this.state.assets[address]?.variants;
    if (!variants) return [];
    return variantsNewestFirst(variants)
      .filter(
        ([variantId, v]) =>
          v.file &&
          v.status === "none" &&
          !exclude?.has(variantId) &&
          isReviewLeaf(this.state, address, variantId) &&
          !this.isStale(address, v),
      )
      .map(([variantId]) => variantId);
  }

  /**
   * The newest of `readyUndecided` — the way out of a stale take that costs no spend, and what a
   * reverted edit hands the address back to.
   */
  newestReadyUndecided(address: string, exclude?: ReadonlySet<string>): string | null {
    return this.readyUndecided(address, exclude)[0] ?? null;
  }

  /**
   * The newest take awaiting a verdict beside an accepted one, which stays the resolved/shown (and
   * downstream-consumed) take meanwhile. Null when nothing is accepted or every rival is settled.
   * The verdict is read from `status` alone (see `VariantStatusSchema`). Behind the preview UI's
   * `hasUndecidedBesideAccepted`, `status`'s staleAwaitingAccept, and the generate/reroll upstream
   * warning.
   */
  undecidedBesideAccepted(address: string, exclude?: ReadonlySet<string>): string | null {
    if (acceptedVariant(this.state, address)?.variant.file == null) return null;
    return this.newestReadyUndecided(address, exclude);
  }

  /**
   * The stale takes at `address`, newest first: the accepted one — whose refresh is a `reroll` — or
   * the undecided ones holding a file, work the next `generate` redoes. A dismissed take is settled
   * whatever its staleness.
   */
  staleVariants(address: string, verdict: "accepted" | "undecided"): StaleVariant[] {
    const result: StaleVariant[] = [];
    for (const [variantId, v] of variantsNewestFirst(this.state.assets[address]?.variants ?? {})) {
      if (verdict === "accepted" ? v.status !== "accepted" : v.status !== "none" || !v.file)
        continue;
      const s = this.staleness(address, v);
      if (s.inputStale || s.definitionStale) result.push({ variantId, ...s });
    }
    return result;
  }

  /**
   * For each dependency, the upstream whose accepted variant a downstream generate/reroll will
   * resolve while a ready, non-stale take sits undecided beside it — the silent case where the
   * downstream builds on the accepted frame after an upstream reroll. A dependency path IS the
   * upstream address.
   */
  undecidedUpstreams(depPaths: readonly string[]): UndecidedUpstreamVariant[] {
    const result: UndecidedUpstreamVariant[] = [];
    for (const address of new Set(depPaths)) {
      const undecidedVariantId = this.undecidedBesideAccepted(address);
      if (!undecidedVariantId) continue;
      const acceptedId = acceptedVariantId(this.state, address);
      if (!acceptedId) continue;
      result.push({ depPath: address, address, acceptedVariantId: acceptedId, undecidedVariantId });
    }
    return result;
  }

  /**
   * Transitive downstream addresses whose accepted variant is now input-stale, or that no take
   * resolves for with an undismissed one input-stale. Walks the dependents graph from `address`.
   * Used to surface "what this accept/reject made stale" without storing flags.
   */
  staleDependents(address: string, dependents: ReadonlyMap<string, readonly string[]>): string[] {
    const marked = new Set<string>();
    const visited = new Set<string>();
    const ctx = this.walk();
    const queue = [...(dependents.get(address) ?? [])];

    while (queue.length > 0) {
      const currentAddr = queue.shift() as string;
      if (visited.has(currentAddr)) continue;
      visited.add(currentAddr);

      // Read through resolution: the accepted take, else — where no take resolves — any take still
      // standing for the address.
      const variants = this.state.assets[currentAddr]?.variants ?? {};
      const core = resolveCore(this.state, currentAddr, ctx);
      const standing = core.acceptedId
        ? [variants[core.acceptedId]!]
        : core.newestFreshId
          ? []
          : Object.values(variants).filter((v) => v.file && v.status !== "dismissed");
      if (
        standing.some(
          (v) =>
            computeVariantStalenessInternal(this.state, currentAddr, v, null, undefined, ctx)
              .inputStale,
        )
      ) {
        marked.add(currentAddr);
      }

      for (const next of dependents.get(currentAddr) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }

    return [...marked];
  }
}

export interface UndecidedUpstreamVariant {
  depPath: string;
  address: string;
  acceptedVariantId: string;
  undecidedVariantId: string;
}
