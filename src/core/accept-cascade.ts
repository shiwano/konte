import {
  COMPOSITION_ASSET_NAME,
  isCompositionAddress,
  isMaterializedLeafAddress,
  isStemAddress,
  listShotStems,
  parseAddress,
} from "./address.js";
import { loadCastReferenceAddresses } from "./characters.js";
import { shotById } from "./shot-index.js";
import {
  applyDirectionReferenceCascade,
  applyDirectionShotCascade,
} from "./direction-acceptance.js";
import type { Direction } from "./dsl/direction.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import type { JobManager } from "./job-manager.js";
import { variantOwningFile } from "./variant-dir.js";
import { inferMediaType } from "./media-type.js";
import { findAllUnmetPrerequisites } from "./review-prerequisites.js";
import type { StateManager } from "./state/index.js";
import type { StageDefinition } from "./types/index.js";
import type { AnimaticDefinition } from "./types/animatic.js";

// When a variant is accepted, the upstream variants it actually consumed should
// be accepted too — otherwise an accepted output can depend on an "undecided"
// (unaccepted) input, which is incoherent, hides staleness (the staleness check
// skips unaccepted upstreams), and lets `clean` garbage-collect the consumed
// variant. This walks the accepted variant's consumed dependencies and accepts
// the exact variant each one consumed, but only for deps that are not already
// accepted (an explicit user choice is never overwritten — a mismatch surfaces
// as staleness instead).
//
// Consumed deps come from two sources. For a generation variant they are
// recovered from the job record's `provenance.resolvedDependencies` (depPath ->
// file path), matched against the upstream asset's `variant.file`. A composition
// variant carries no job record, so (when `video` is supplied) its deps come from
// the shot's `compositionRefs` resolved against current state — the same
// resolution the composition HTML was built with — so timeline assets used only in
// a shotFn (logos, overlays) are accepted along with the composition. Returns the
// addresses newly accepted.
//
// Audio is signed off in context via its stem, not through the composition: a composition
// (picture) accept skips audio deps, and audio is accepted by accepting the shot's `stem` /
// `timeline#stem`. A stem accept, conversely, DOES cascade its audio sources — the shot's
// `<Audio>`/`<Video hasAudio>` takes and the `soundtrack()` bed (including a reference BGM) — so
// each gets an accepted baseline (symmetric with how a composition accept cascades its picture
// sources). So the audio-skip below applies only to a composition/generation-rooted walk, never a
// stem-rooted one (`allowAudio`).
//
// Cast references (`reference:<id>` for a `direction` character's look, and every cast voice
// sample) are skipped for the same reason: the cast is reviewed and accepted only in
// `konte preview reference`, never implicitly through a shot that consumes it. The generate gate
// (see assertCharactersAccepted / assertVoicesAccepted) guarantees the cast is already accepted
// before any downstream is generated, so skipping here only closes the reverse hole — an
// un-accepted cast reference being silently re-accepted by a later downstream accept. A voice
// sample needs the rule of its own: it is audio, so a stem-rooted walk (which signs off the audio
// that plays) would otherwise reach the sample the line was cloned from.
// The stage an address names, or null when it does not parse — the root's stage decides whether a
// composition accept signs off its audio.
function tryStageOf(address: string): string | null {
  try {
    return parseAddress(address).stage;
  } catch {
    return null;
  }
}

export async function cascadeAcceptConsumedDeps(
  manager: StateManager,
  jobManager: JobManager,
  address: string,
  variantId: string,
  opts: {
    video?: StageDefinition;
    // The board, so a dep whose review prerequisites are unwritten can be left for its own
    // deliberate accept rather than signed off sideways. Omitted, nothing is held back.
    animatic?: AnimaticDefinition | null;
    // The cast references to exclude; loaded from `direction.ts` when omitted.
    castAddresses?: ReadonlySet<string>;
    // Cascade audio deps even though the root is not itself a stem — used when accepting a stem
    // SOURCE (an audio take) as part of the stem sign-off, so the source's own audio sub-deps are
    // accepted too rather than skipped as they would be under a picture/generation root.
    forceAllowAudio?: boolean;
  },
): Promise<string[]> {
  const accepted: string[] = [];
  const visited = new Set<string>([address]);
  // The take a patched root corrects, named by the lineage rather than inferred from "some other
  // variant at this address": that edge is a patch's alone today, and reading `derivedFrom` says so
  // instead of trusting it. Null for an ordinary root, which closes the pass-through entirely.
  const correctedTakeId = manager.tryGetAssetState(address)?.variants?.[variantId]?.derivedFrom;
  let correctedTakeWalked = false;
  const defs = { animatic: opts.animatic };
  // Which loaded stage owns an address. Both composition stages have compositions and stems, so a
  // branch keyed on `opts.video` signs off nothing when the root is the board's.
  const stageDef = (stage: string | undefined): StageDefinition | undefined => {
    if (opts.video?.stage === stage) return opts.video;
    if (opts.animatic && opts.animatic.stage === stage) return opts.animatic;
    return undefined;
  };
  const castAddresses = opts.castAddresses ?? (await loadCastReferenceAddresses(manager.videoRoot));

  // The (depAddress -> depVariantId) pairs the given accepted target consumed.
  async function consumedDeps(
    addr: string,
    vid: string,
  ): Promise<Array<{ depAddress: string; depVariantId: string }>> {
    // A composition/stem target has no job record; derive its deps from the definition.
    let parsed: ReturnType<typeof parseAddress> | null = null;
    try {
      parsed = parseAddress(addr);
    } catch {
      parsed = null;
    }
    // A stem's audio sources: a shot stem consumes its cues (`listShotStems`); a `timeline#stem`
    // consumes the soundtrack beds. Resolved against current state, like the composition branch.
    const stage = stageDef(parsed?.stage);
    if (stage && parsed && isStemAddress(addr)) {
      const shot = parsed.kind === "shot" ? shotById(stage.shots, parsed.shotId) : undefined;
      const srcPaths =
        parsed.kind === "shot"
          ? ((shot && listShotStems(stage.stage, shot).find((s) => s.address === addr)?.refs) ?? [])
          : (stage.timelineSoundtracks ?? [])
              .map((st) => parsePlaceholder(st.src.src))
              .filter((p): p is string => p !== null);
      const pairs: Array<{ depAddress: string; depVariantId: string }> = [];
      for (const depAddress of srcPaths) {
        const resolved = manager.resolveReference(depAddress);
        if (resolved) pairs.push({ depAddress, depVariantId: resolved.variantId });
      }
      return pairs;
    }
    // A shot composition's refs. The board's DOES sign off its audio — the animatic exists to settle
    // the sound the motion is driven by — and the root's `allowAudio` (below) says so; the delivered
    // one does not, its audio being accepted on the stem. A cast voice sample is excluded either
    // way, `walk` skipping those.
    if (stage && parsed?.kind === "shot" && parsed.assetName === COMPOSITION_ASSET_NAME) {
      const shot = shotById(stage.shots, parsed.shotId);
      const pairs: Array<{ depAddress: string; depVariantId: string }> = [];
      // The shot's own refs. Under a delivered root `walk` drops the audio among them (the timeline
      // soundtracks it is muxed under are accepted on the audio track); under a board root it keeps
      // them.
      const depAddresses = shot?.compositionRefs ?? [];
      for (const depAddress of depAddresses) {
        const resolved = manager.resolveReference(depAddress);
        if (resolved) pairs.push({ depAddress, depVariantId: resolved.variantId });
      }
      return pairs;
    }

    // A patched take has no job of its own: it is materialized from the chain's returned step and
    // points at that step's file. The step's job is what recorded what the correction consumed, so
    // the cascade follows the pointer to reach it — otherwise accepting a correction would sign off
    // on nothing, and `clean` could then take the very takes it was built from.
    const file = manager.tryGetAssetState(addr)?.variants?.[vid]?.file;
    const owner = file ? variantOwningFile(manager.getState(), file) : null;
    const provenanceVariantId = owner && owner.variantId !== vid ? owner.variantId : vid;

    let resolvedDependencies: Record<string, string>;
    try {
      const job = await jobManager.getJob(provenanceVariantId);
      // Only generation jobs carry provenance; download jobs produce no variant.
      if (job.kind !== "generation") return [];
      resolvedDependencies = job.provenance.resolvedDependencies;
    } catch {
      // No job record (e.g. file/deterministic assets) — nothing to accept.
      return [];
    }

    const pairs: Array<{ depAddress: string; depVariantId: string }> = [];
    for (const [depAddress, depFile] of Object.entries(resolvedDependencies)) {
      const variants = manager.tryGetAssetState(depAddress)?.variants;
      if (!variants) continue;
      const depVariantId = Object.entries(variants).find(([, v]) => v.file === depFile)?.[0];
      if (!depVariantId) continue; // consumed variant was cleaned/pruned
      pairs.push({ depAddress, depVariantId });
    }
    return pairs;
  }

  // Audio is accepted only on its own timeline track — never as a cascaded dep.
  const isAudioDep = (depAddress: string, depVariantId: string): boolean => {
    const file = manager.tryGetAssetState(depAddress)?.variants?.[depVariantId]?.file;
    return !!file && inferMediaType(file) === "audio";
  };

  async function walk(addr: string, vid: string, allowAudio: boolean): Promise<void> {
    for (const { depAddress, depVariantId } of await consumedDeps(addr, vid)) {
      // A patch chain leads back to the take it corrects — this walk's own root address, whichever
      // step consumed `source`. The patched take inherits that take's inputs, so what it consumed
      // is what the correction rests on: walk through it without signing it off. Once only — a
      // lineage is one level deep, and the flag is what stops a state pointing a take at itself.
      if (depAddress === address && depVariantId === correctedTakeId) {
        if (correctedTakeWalked) continue;
        correctedTakeWalked = true;
        await walk(depAddress, depVariantId, allowAudio);
        continue;
      }

      if (visited.has(depAddress)) continue;
      visited.add(depAddress);

      // The three exclusions come FIRST, before the accepted-dep traversal below. Each marks a
      // subtree another surface owns, and an accept sitting on the boundary must not become a way
      // in: recursing through an accepted audio take or cast reference would sign off what it was
      // built from on a walk that is not allowed to decide anything there.

      // Audio rides its own (stem) accept path — skip it here unless this walk is rooted at a
      // stem, whose whole purpose is to sign off its audio sources.
      if (!allowAudio && isAudioDep(depAddress, depVariantId)) continue;

      // A cast reference is accepted only in `konte preview reference` — never cascaded.
      if (castAddresses.has(depAddress)) continue;

      // A dep with an unwritten review prerequisite is skipped rather than signed off sideways:
      // accepting a landing panel would otherwise cascade into the unbound panel that feeds it,
      // past the gate its own accept has to clear. Skipping (not throwing) keeps a cascade from
      // half-applying; the dep then needs the deliberate accept the gate covers.
      if (findAllUnmetPrerequisites(defs, manager.getState(), new Set([depAddress])).length > 0) {
        continue;
      }

      // Respect an existing accept — never overwrite it — but keep walking THROUGH it, at the take
      // that accept names rather than the one this root consumed: that take is what the address
      // stands for now, and what its own inputs are judged against. Stopping here instead made a
      // sign-off depend on the order takes happened to be accepted in.
      const acceptedDepVariantId = manager.getAcceptedVariant(depAddress);
      if (acceptedDepVariantId) {
        await walk(depAddress, acceptedDepVariantId, allowAudio);
        continue;
      }

      // A deterministic dep is signed off as konte's own, whatever this walk is rooted at — see
      // `setAccepted`.
      manager.setAccepted(depAddress, depVariantId);
      accepted.push(depAddress);
      await walk(depAddress, depVariantId, allowAudio);
    }
  }

  await walk(
    address,
    variantId,
    isStemAddress(address) ||
      (isCompositionAddress(address) && tryStageOf(address) === "animatic") ||
      (opts.forceAllowAudio ?? false),
  );
  return accepted;
}

/**
 * Whether the accepted take at `address` is a human's verdict konte must not replace on its own: a
 * generation or patch output. A deterministic take is re-baked whatever its accept says, and a
 * materialized leaf is re-materialized by its own accept.
 */
export function holdsHumanVerdict(manager: StateManager, address: string): boolean {
  if (isMaterializedLeafAddress(address)) return false;
  const variantId = manager.getAcceptedVariant(address);
  if (variantId === null) return false;
  const variant = manager.tryGetAssetState(address)?.variants?.[variantId];
  if (!variant?.file) return false;
  return variant.derivedFrom != null || !manager.registeredDeterministic(address);
}

/**
 * A human accept of an input-stale take keeps it against the upstream as it resolves now. Run after
 * `cascadeAcceptConsumedDeps`, whose accepts can bring an input back in line. `keeps` narrows which
 * moved inputs are kept. Returns the upstream addresses kept against.
 */
export function keepAcceptedInputs(
  manager: StateManager,
  address: string,
  variantId: string,
  keeps: (input: { assetPath: string; current: string | null }) => boolean = () => true,
): string[] {
  if (manager.getAcceptedVariant(address) !== variantId) return [];
  if (!holdsHumanVerdict(manager, address)) return [];
  const staleness = manager.variantStaleness(address, variantId);
  if (!staleness?.inputStale) return [];
  const inputs = staleness.changedInputs.filter((input) => input.current !== null && keeps(input));
  if (inputs.length === 0) return [];
  const variant = manager.getAssetState(address).variants![variantId]!;
  const kept = { ...variant.keptInputs };
  for (const input of inputs) kept[input.assetPath] = input.current!;
  variant.keptInputs = kept;
  return inputs.map((input) => input.assetPath);
}

// The second cascade an accept runs: sideways into the direction rather than upstream through the
// graph. The shots a review settled carry their sign-off back to the direction parts that describe
// them — see `applyDirectionShotCascade` for what that does and does not sign off. Callers derive
// the shot ids from the addresses they accepted with `directionCascadeShotIds`. Returns the
// restamped part addresses; writes nothing when there are none, so a video with no direction (or one
// whose direction was never accepted) is a no-op.
export function cascadeDirectionShotAccepts(
  manager: StateManager,
  direction: Direction | null,
  shotIds: ReadonlySet<string>,
): string[] {
  if (!direction || shotIds.size === 0) return [];
  const prior = manager.getDirectionAcceptance();
  const { acceptance, restamped } = applyDirectionShotCascade(direction, prior, shotIds);
  // Identity, not `restamped.length`: the cascade also sweeps orphans the gate has stopped reading,
  // and a write that only swept has an empty `restamped` with a record that really did change.
  if (acceptance && acceptance !== prior) manager.setDirectionAcceptance(acceptance);
  return restamped;
}

// The reference-stage twin of `cascadeDirectionShotAccepts`: the roster entries an accepted
// `reference:<id>` image describes carry that sign-off back to the direction — see
// `applyDirectionReferenceCascade` for the guard. Callers derive the ids from the addresses they
// accepted with `directionCascadeReferenceIds`.
export function cascadeDirectionReferenceAccepts(
  manager: StateManager,
  direction: Direction | null,
  referenceIds: ReadonlySet<string>,
): string[] {
  if (!direction || referenceIds.size === 0) return [];
  const prior = manager.getDirectionAcceptance();
  const { acceptance, restamped } = applyDirectionReferenceCascade(direction, prior, referenceIds);
  // Identity, not `restamped.length` — see `cascadeDirectionShotAccepts`.
  if (acceptance && acceptance !== prior) manager.setDirectionAcceptance(acceptance);
  return restamped;
}
