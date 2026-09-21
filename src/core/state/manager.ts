import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  assetsGitTracking,
  renderAssetsGitignore,
  syncAssetsGitignore,
} from "../assets-gitignore.js";
import { writeFileAtomic } from "../atomic-write.js";
import { KonteError, errorMessage } from "../errors.js";
import { withFileLock } from "../file-lock.js";
import {
  computeVariantStaleness,
  createStalenessCache,
  newestReadyUndecidedTake,
  type PatchHashes,
  type ResolutionDefinitions,
  selectResolvedVariant,
  type StalenessCache,
  type VariantStaleness,
} from "../staleness.js";
import { resolutionDefinitionsFor } from "./resolution-definitions.js";
import { generateVariantId } from "../variant-id.js";
import { isReviewLeaf } from "../variant-lineage.js";
import {
  type AssetState,
  type DirectionAcceptance,
  type KonteState,
  KonteStateSchema,
  SCHEMA_VERSION,
  type VariantState,
} from "../types/index.js";

const STATE_FILE = "konte.state.json";

/**
 * The reservation stamp for a new variant: now, or one millisecond past the newest take already at
 * the address when the wall clock has gone backwards since that one was reserved.
 *
 * `createdAt` is what "newest" means — `variantsNewestFirst`, and through it which take an address
 * resolves to. A clock that steps back (a VM's time sync, an NTP correction) would otherwise leave a
 * take that is genuinely newer sorting as older, and the address would resolve to the one it
 * replaced: a correction ignored in favour of the take it corrected. Monotonic per address is enough
 * — nothing compares reservation times across addresses.
 */
function nextCreatedAt(variants: Record<string, VariantState>): string {
  const now = new Date().toISOString();
  let latest = "";
  for (const v of Object.values(variants)) {
    if (v.createdAt > latest) latest = v.createdAt;
  }
  if (latest < now) return now;
  return new Date(new Date(latest).getTime() + 1).toISOString();
}

export interface ResolvedReference {
  variantId: string;
  file: string;
  outputHash: string | null;
  isAccepted: boolean;
}

function defaultAssetState(): AssetState {
  return {
    variants: {},
  };
}

export class StateManager {
  readonly videoRoot: string;
  private state: KonteState;
  private savedSerialized: string | null;
  private resolutionDefinitions: ResolutionDefinitions | null = null;
  // Absent variants: their media is kept from git by `assets/.gitignore` and not on disk (a clone).
  // Keyed by address with its recorded variant order. Withheld from every reader and written back
  // in place, so a clone never records the absence.
  private absentVariants = new Map<
    string,
    { order: string[]; variants: Map<string, VariantState> }
  >();

  private constructor(videoRoot: string, state: KonteState, savedSerialized: string | null = null) {
    this.videoRoot = videoRoot;
    this.state = state;
    this.savedSerialized = savedSerialized;
  }

  private get statePath(): string {
    return path.join(this.videoRoot, STATE_FILE);
  }

  static async init(videoRoot: string): Promise<StateManager> {
    const statePath = path.join(videoRoot, STATE_FILE);
    const lockPath = path.join(videoRoot, `${STATE_FILE}.lock`);

    // Exists-check and create under the same lock every other state writer takes: a bare check
    // then write would let a concurrent init (or a writer racing a fresh project) pass the check
    // and have its state clobbered by the second one's overwriting rename.
    return withFileLock(lockPath, async () => {
      try {
        await fs.access(statePath);
        throw new KonteError("STATE_ALREADY_EXISTS", `State file already exists at "${statePath}"`);
      } catch (err) {
        if (err instanceof KonteError) throw err;
        // Only a genuinely-absent file means we may proceed; a permission or I/O
        // error must not be swallowed and read as "does not exist".
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      const state: KonteState = {
        schemaVersion: SCHEMA_VERSION,
        assets: {},
        directionAcceptance: null,
      };

      const manager = new StateManager(videoRoot, state);
      await manager.save();
      return manager;
    });
  }

  static async withLock<T>(
    videoRoot: string,
    fn: (manager: StateManager) => Promise<T>,
  ): Promise<T> {
    const lockPath = path.join(videoRoot, `${STATE_FILE}.lock`);
    return withFileLock(lockPath, async () => {
      // Under the lock, no live writer competes for the state file, so it is safe to adopt
      // a crashed writer's leftover temp. Readers (bare `load`) never do this — otherwise a
      // reader could steal an in-flight `writeFileAtomic` temp out from under a live writer.
      await StateManager.recoverFromTemp(videoRoot);
      const manager = await StateManager.load(videoRoot);
      const result = await fn(manager);
      await manager.save();
      return result;
    });
  }

  static async load(videoRoot: string): Promise<StateManager> {
    const statePath = path.join(videoRoot, STATE_FILE);

    let raw: string;
    try {
      raw = await fs.readFile(statePath, "utf-8");
    } catch {
      throw new KonteError("STATE_NOT_FOUND", `State file not found at "${statePath}"`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new KonteError("VALIDATION_FAILED", `Invalid JSON in state file "${statePath}"`);
    }

    const result = KonteStateSchema.safeParse(parsed);
    if (!result.success) {
      throw new KonteError("VALIDATION_FAILED", `State validation failed: ${result.error.message}`);
    }

    const manager = new StateManager(videoRoot, result.data, JSON.stringify(result.data, null, 1));
    await manager.withholdAbsentVariants();
    return manager;
  }

  private async withholdAbsentVariants(): Promise<void> {
    const tracking = assetsGitTracking(this.state);
    const candidates: Array<{ address: string; variantId: string; file: string }> = [];
    for (const [address, asset] of Object.entries(this.state.assets)) {
      for (const [variantId, variant] of Object.entries(asset.variants ?? {})) {
        if (variant.file && tracking.ignores(variant.file)) {
          candidates.push({ address, variantId, file: variant.file });
        }
      }
    }
    const absent = await Promise.all(
      candidates.map(({ file }) =>
        fs.access(path.resolve(this.videoRoot, file)).then(
          () => false,
          (err: NodeJS.ErrnoException) => err.code === "ENOENT" || err.code === "ENOTDIR",
        ),
      ),
    );
    for (const [i, { address, variantId }] of candidates.entries()) {
      if (!absent[i]) continue;
      const variants = this.state.assets[address]?.variants as Record<string, VariantState>;
      let entry = this.absentVariants.get(address);
      if (!entry) {
        entry = { order: Object.keys(variants), variants: new Map() };
        this.absentVariants.set(address, entry);
      }
      entry.variants.set(variantId, variants[variantId] as VariantState);
      delete variants[variantId];
    }
  }

  assertNotAbsent(variantId: string): void {
    if (!this.absentVariantIds().has(variantId)) return;
    throw new KonteError(
      "VARIANT_ABSENT",
      `Variant "${variantId}" is in state, but its media is not in this checkout — git tracks only accepted takes`,
    );
  }

  /** Ids of the absent variants: in state, but their media is not in this checkout. */
  absentVariantIds(): ReadonlySet<string> {
    return new Set(
      [...this.absentVariants.values()].flatMap((entry) => [...entry.variants.keys()]),
    );
  }

  /**
   * The state as recorded on disk: `getState`, plus the absent variants in their places. For what
   * acts on a variant whatever its media, such as deleting it.
   */
  getRecordedState(): KonteState {
    if (this.absentVariants.size === 0) return this.state;
    const assets = { ...this.state.assets };
    for (const [address, absent] of this.absentVariants) {
      const asset = assets[address];
      if (!asset) continue;
      const live = asset.variants ?? {};
      const variants: Record<string, VariantState> = {};
      for (const id of absent.order) {
        const variant = live[id] ?? absent.variants.get(id);
        if (variant) variants[id] = variant;
      }
      for (const [id, variant] of Object.entries(live)) variants[id] ??= variant;
      assets[address] = { ...asset, variants };
    }
    return { ...this.state, assets };
  }

  // Adopt a crashed writer's leftover temp as the committed state file (idempotent), then
  // `load` reads it back normally. MUST be called while holding the state lock — see `withLock`.
  // writeFileAtomic leaves a uniquely-named temp alongside the main file on a crash before the
  // first atomic rename committed.
  private static async recoverFromTemp(videoRoot: string): Promise<void> {
    const statePath = path.join(videoRoot, STATE_FILE);
    // Nothing to recover if the committed file is already present.
    try {
      await fs.access(statePath);
      return;
    } catch {
      // fall through — the file is missing, look for an adoptable temp
    }

    const tempPrefix = `.${STATE_FILE}.`;
    let entries: string[];
    try {
      entries = await fs.readdir(videoRoot);
    } catch {
      return;
    }
    const temps = entries.filter((e) => e.startsWith(tempPrefix) && e.endsWith(".tmp"));

    for (const name of temps) {
      const tmpPath = path.join(videoRoot, name);
      try {
        const result = KonteStateSchema.safeParse(JSON.parse(await fs.readFile(tmpPath, "utf-8")));
        if (result.success) {
          await fs.rename(tmpPath, statePath);
          for (const other of temps) {
            if (other !== name) {
              await fs.unlink(path.join(videoRoot, other)).catch(() => {});
            }
          }
          return;
        }
      } catch {
        // try the next candidate
      }
    }

    // none were valid — drop the junk so it does not accumulate
    for (const name of temps) {
      await fs.unlink(path.join(videoRoot, name)).catch(() => {});
    }
  }

  getState(): KonteState {
    return this.state;
  }

  getAssetState(address: string): AssetState {
    const assetState = this.state.assets[address];
    if (!assetState) {
      throw new KonteError("ASSET_NOT_FOUND", `Asset state not found for address "${address}"`);
    }
    return assetState;
  }

  tryGetAssetState(address: string): AssetState | undefined {
    return this.state.assets[address];
  }

  ensureAssetState(address: string): AssetState {
    if (!this.state.assets[address]) {
      this.state.assets[address] = defaultAssetState();
    }
    return this.state.assets[address];
  }

  findVariantAddress(variantId: string): string | null {
    for (const [address, assetState] of Object.entries(this.state.assets)) {
      if (assetState.variants?.[variantId]) {
        return address;
      }
    }
    return null;
  }

  resolveVariantAddress(variantId: string): string {
    const address = this.findVariantAddress(variantId);
    if (!address) {
      this.assertNotAbsent(variantId);
      throw new KonteError("VARIANT_NOT_FOUND", `Variant "${variantId}" not found in state`);
    }
    return address;
  }

  reserveVariantId(address: string): string {
    const target = this.ensureAssetState(address);
    if (!target.variants) {
      target.variants = {};
    }
    const nextId = generateVariantId();
    target.variants[nextId] = {
      status: "none",
      file: null,
      definitionHash: null,
      outputHash: null,
      createdAt: nextCreatedAt(target.variants),
      readyAt: null,
      decidedAt: null,
      inputFingerprints: {},
      seed: null,
      derivedFrom: null,
      patchHash: null,
      metadata: {},
    };
    return nextId;
  }

  getAcceptedVariant(address: string): string | null {
    const target = this.state.assets[address];
    if (!target?.variants) return null;
    for (const [variantId, v] of Object.entries(target.variants)) {
      if (v.status === "accepted") {
        return variantId;
      }
    }
    return null;
  }

  // The human's per-part sign-off on the direction (or null if nothing was ever accepted).
  // Raw state: what each recorded part hashed to when it was accepted, plus the whole-direction
  // short-circuit. Reading a verdict out of it against a live direction is `direction-acceptance.ts`'s
  // job — the spend gate, status and the review page all go through there rather than compare here.
  getDirectionAcceptance(): DirectionAcceptance | null {
    return this.state.directionAcceptance ?? null;
  }

  setDirectionAcceptance(acceptance: DirectionAcceptance | null): void {
    this.state.directionAcceptance = acceptance;
  }

  /**
   * Install the definitions resolution reads (see `ResolutionDefinitions`), for this manager alone.
   * Commands normally register them per video root instead (`applyResolutionDefinitions`), which
   * every manager over that root — including `withLock`'s own — picks up.
   */
  useResolutionDefinitions(definitions: ResolutionDefinitions | null): void {
    this.resolutionDefinitions = definitions;
  }

  /**
   * What this manager judges a take's own definition by: its own installed definitions, else
   * whatever is registered for its video root, else nothing — leaving the input axis alone.
   */
  private definitions(): ResolutionDefinitions | undefined {
    return this.resolutionDefinitions ?? resolutionDefinitionsFor(this.videoRoot);
  }

  /**
   * The definition hash of any address, routed to the stage that owns it by the registered
   * definitions — the same resolver staleness itself walks. A caller holding one stage's definition
   * cannot answer for another's, and asking it anyway compares a cross-stage take against no hash
   * at all, which reads a definition-stale rival as fresh.
   */
  registeredDefinitionHash(address: string): string | null {
    return this.definitions()?.definitionHash(address) ?? null;
  }

  /**
   * Whether the registered definitions declare the address deterministic — false when they do not
   * declare it, or none are registered.
   */
  registeredDeterministic(address: string): boolean {
    return this.definitions()?.isDeterministic(address) === true;
  }

  /**
   * A staleness cache carrying this manager's definitions, for a read-only pass that resolves more
   * than one address. Drop it on any write.
   */
  stalenessCache(): StalenessCache {
    return createStalenessCache(this.definitions());
  }

  /**
   * The definitions a call is answered under: a passed-in memo's own, else this manager's. Mixing a
   * memo's answers with a fresh lookup measures one take against two snapshots — which is reachable
   * in a long-lived process, where a reload re-registers mid-flight.
   */
  private definitionsFor(cache?: StalenessCache): ResolutionDefinitions | undefined {
    return cache ? cache.definitions : this.definitions();
  }

  /**
   * The variant an address resolves to, under this manager's definitions — `selectResolvedVariant`
   * with the definition axis wired in. Callers holding a manager go through here.
   */
  selectVariant(
    address: string,
    options?: { includeStale?: boolean; requireAccepted?: boolean },
    cache?: StalenessCache,
  ): { variantId: string; isAccepted: boolean } | null {
    return selectResolvedVariant(this.state, address, options, cache ?? this.stalenessCache());
  }

  /**
   * How the take at `address` stands against the current definition and its inputs, under the
   * installed definitions — null when either is unknown.
   */
  variantStaleness(
    address: string,
    variantId: string,
    cache?: StalenessCache,
  ): VariantStaleness | null {
    const variant = this.state.assets[address]?.variants?.[variantId];
    if (!variant) return null;
    const definitions = this.definitionsFor(cache);
    return computeVariantStaleness(
      this.state,
      address,
      variant,
      definitions?.definitionHash(address) ?? null,
      definitions?.patchHashes,
      cache ?? this.stalenessCache(),
    );
  }

  /**
   * The patch-script hashes the installed definitions carry, or undefined when no patch catalog was
   * loaded for this root — the difference between "that script is gone" and "nobody looked".
   */
  patchHashes(): PatchHashes | undefined {
    return this.definitions()?.patchHashes;
  }

  /**
   * The take already at `address` that matches the current definition and inputs, if any — what a
   * stale take is refreshed BY when the material is already on disk (see `newestReadyUndecidedTake`).
   */
  matchingReadyTake(
    address: string,
    excludeVariantId?: string,
    cache?: StalenessCache,
  ): string | null {
    const definitions = this.definitionsFor(cache);
    return newestReadyUndecidedTake(
      this.state,
      address,
      definitions?.definitionHash(address) ?? null,
      excludeVariantId === undefined ? undefined : new Set([excludeVariantId]),
      definitions?.patchHashes,
      cache ?? this.stalenessCache(),
    );
  }

  resolveReference(
    address: string,
    options?: { includeStale?: boolean; requireAccepted?: boolean },
    cache?: StalenessCache,
  ): ResolvedReference | null {
    const selected = this.selectVariant(address, options, cache);
    if (!selected) return null;
    const v = this.state.assets[address]?.variants?.[selected.variantId];
    if (!v?.file) return null;
    return {
      variantId: selected.variantId,
      file: path.resolve(this.videoRoot, v.file),
      outputHash: v.outputHash ?? null,
      isAccepted: selected.isAccepted,
    };
  }

  /**
   * `dismiss` are the rival takes this accept decides against (see `VariantStatusSchema`). Only a
   * human accept passes them: konte's own accepts and the cascades sign off what a consumer used,
   * which says nothing about the takes nobody looked at.
   */
  setAccepted(address: string, variantId: string, opts?: { dismiss?: readonly string[] }): void {
    const target = this.getAssetState(address);
    if (!target.variants) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Variant "${variantId}" not found for address "${address}"`,
      );
    }
    const variant = target.variants[variantId];
    if (!variant) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Variant "${variantId}" not found for address "${address}"`,
      );
    }

    const decidedAt = new Date().toISOString();
    const dismiss = new Set(opts?.dismiss ?? []);
    // The take this accept replaces. Decided against when the caller had it in front of them (a
    // reviewer switching takes, a CLI accept naming another id); merely undecided otherwise — an
    // accept konte makes itself must record no verdict on a take a human accepted while its job
    // ran. The leaf rule applies here as to any rival: the take a correction was made from is its
    // "before", and `konte patch remove` may hand the address back to it.
    for (const [id, v] of Object.entries(target.variants)) {
      if (v.status !== "accepted" || id === variantId) continue;
      const settled = dismiss.has(id) && isReviewLeaf(this.state, address, id);
      v.status = settled ? "dismissed" : "none";
      v.decidedAt = settled ? decidedAt : null;
    }

    variant.status = "accepted";
    variant.decidedAt = decidedAt;

    this.dismissTakes(address, [...dismiss], variantId, decidedAt);
  }

  /**
   * Record the takes an accept decided against: undecided ones among `variantIds`, minus the take
   * that was chosen. The ids are the caller's — the candidates the reviewer actually had in front
   * of them — and are never re-derived from what the address holds now, since a reroll that landed
   * mid-review is nobody's decision yet. Ids that are gone, already settled, or no longer a review
   * candidate (a take something was patched off) are skipped.
   *
   * Public for the accept paths that keep a standing accept in place — a shot accept re-signing an
   * audio source it did not move still settles that source's rivals.
   */
  dismissTakes(
    address: string,
    variantIds: readonly string[],
    chosenVariantId: string,
    at: string = new Date().toISOString(),
  ): void {
    const variants = this.state.assets[address]?.variants;
    if (!variants) return;
    for (const variantId of variantIds) {
      const rival = variants[variantId];
      if (!rival || variantId === chosenVariantId || rival.status !== "none") continue;
      if (!isReviewLeaf(this.state, address, variantId)) continue;
      rival.status = "dismissed";
      rival.decidedAt = at;
    }
  }

  /**
   * The verdict against one take, made without choosing another — what `konte dismiss` records, and
   * `dismissTakes`'s standalone half. Where `dismissTakes` skips what it cannot settle, this throws:
   * nothing is decided silently.
   *
   * Returns whether the verdict moved. A take already carrying it keeps its `decidedAt`.
   */
  setDismissed(address: string, variantId: string, dismissed: boolean): boolean {
    const variant = this.state.assets[address]?.variants?.[variantId];
    if (!variant) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Variant "${variantId}" not found for address "${address}"`,
      );
    }
    if (variant.status === "accepted") {
      throw new KonteError(
        "VARIANT_ACCEPTED",
        `Variant "${variantId}" is accepted — clear it with \`konte accept ${variantId} --off\` first`,
      );
    }
    if (dismissed && variant.file === null) {
      throw new KonteError(
        "VARIANT_NOT_REVIEWABLE",
        `Variant "${variantId}" has no output to decide against — its job is still running, or it failed`,
      );
    }
    if (dismissed && !isReviewLeaf(this.state, address, variantId)) {
      throw new KonteError(
        "VARIANT_NOT_REVIEWABLE",
        `Variant "${variantId}" is not a review candidate: a patch was made from it. ` +
          `\`konte patch remove ${variantId}\` hands the address back to it`,
      );
    }
    if (!dismissed && variant.status !== "dismissed") {
      throw new KonteError(
        "VARIANT_NOT_DISMISSED",
        `Variant "${variantId}" carries no dismissal to lift`,
      );
    }
    if (dismissed && variant.status === "dismissed") return false;
    variant.status = dismissed ? "dismissed" : "none";
    variant.decidedAt = dismissed ? new Date().toISOString() : null;
    return true;
  }

  setUnaccepted(address: string, variantId: string): void {
    const target = this.state.assets[address];
    if (!target?.variants?.[variantId]) {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Variant "${variantId}" not found for address "${address}"`,
      );
    }
    const variant = target.variants[variantId];
    if (variant.status !== "accepted") {
      throw new KonteError(
        "VARIANT_NOT_ACCEPTED",
        `Variant "${variantId}" is not accepted for address "${address}"`,
      );
    }
    variant.status = "none";
    variant.decidedAt = null;
  }

  // An absent variant is removable too: `getRecordedState` is what a deleting caller reads.
  removeVariant(address: string, variantId: string): void {
    const target = this.state.assets[address];
    if (target?.variants?.[variantId]) {
      delete target.variants[variantId];
      return;
    }
    if (this.absentVariants.get(address)?.variants.delete(variantId)) return;
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      `Variant "${variantId}" not found for address "${address}"`,
    );
  }

  removeAsset(address: string): boolean {
    if (!this.state.assets[address]) return false;
    delete this.state.assets[address];
    this.absentVariants.delete(address);
    return true;
  }

  // A no-op `withLock` (a read-only pass, a feedback-only submit) must not touch the state file: an
  // open preview watches its mtime and would announce a state change that never happened.
  // `assets/.gitignore` is synced either way, so a failed sync or a hand edit is repaired by the next
  // save in any process; an unchanged one is not rewritten.
  async save(): Promise<void> {
    const recorded = this.getRecordedState();
    const serialized = JSON.stringify(recorded, null, 1);
    if (serialized !== this.savedSerialized) {
      try {
        await writeFileAtomic(this.statePath, serialized);
      } catch (err) {
        throw new KonteError(
          "STATE_WRITE_FAILED",
          `Failed to write state file: ${errorMessage(err)}`,
        );
      }
      this.savedSerialized = serialized;
    }
    try {
      await syncAssetsGitignore(this.videoRoot, recorded);
    } catch (err) {
      throw new KonteError(
        "STATE_WRITE_FAILED",
        `assets/.gitignore could not be written (the next save retries): ${errorMessage(err)}`,
      );
    }
  }

  /** `assets/.gitignore` as this state renders it — what `save` keeps on disk. */
  renderAssetsGitignore(): string {
    return renderAssetsGitignore(this.getRecordedState());
  }
}
