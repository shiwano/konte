import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StageDefinition } from "../../../core/types/index.js";
import {
  assetNameOf,
  COMPOSITION_ASSET_NAME,
  type DefinitionLike,
  formatAddress,
  formatCompositionAddress,
  formatPlateAssetPath,
  type ShotStage,
  formatReferenceAddress,
  formatTimelineAddress,
  formatTimelineAssetPath,
  formatTimelineOverlayAddress,
  formatTimelineStemAddress,
  listReviewableAssetPaths,
  listShotStems,
  parseAddress,
  STEM_ASSET_NAME,
} from "../../../core/address.js";
import {
  definitionHashForAddress,
  materializedLeafContentHash,
} from "../../../core/composition-resource.js";
import { directionPartHashes } from "../../../core/direction-hash.js";
import type { Direction } from "../../../core/dsl/direction.js";
import { KonteError } from "../../../core/errors.js";
import { computeChangeInfo } from "../../../core/review-diff.js";
import {
  buildTimestamp,
  loadLatestReviewRecord,
  REVIEW_DIR,
  type ReviewRecord,
} from "../../../core/review-record.js";
import { isAcceptedStale } from "../../../core/staleness.js";
import { StateManager } from "../../../core/state/index.js";
import type { Handoff, HandoffNote } from "../../../core/types/handoff.js";
import type {
  AnimaticDefinition,
  ReferenceDefinition,
  VariantState,
  VideoDefinition,
} from "../../../core/types/index.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

// `--note "<address>=<text>"` — split on the first `=`, since an address never contains one
// but note prose might.
export function parseNoteOption(value: string, previous: HandoffNote[]): HandoffNote[] {
  const eq = value.indexOf("=");
  if (eq === -1 || value.slice(eq + 1).trim() === "") {
    throw new KonteError(
      "INVALID_OPTION",
      `--note must be "<address>=<text>", got ${JSON.stringify(value)}`,
    );
  }
  previous.push({ address: value.slice(0, eq).trim(), text: value.slice(eq + 1) });
  return previous;
}

// Resolve the variant currently shown for each shot's assets, leniently: an asset
// with no ready variant is simply omitted (no throw). Used only to diff against
// the review, so a full render plan is neither needed nor wanted here.
function resolveCurrentVariantsByShot(
  shots: Array<{ id: string; assets: Record<string, unknown> }>,
  stage: ShotStage,
  manager: StateManager,
): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const shot of shots) {
    const variants: Record<string, string> = {};
    for (const assetName of Object.keys(shot.assets)) {
      const result = manager.resolveReference(formatAddress(stage, shot.id, assetName));
      if (result) variants[assetName] = result.variantId;
    }
    map.set(shot.id, variants);
  }
  return map;
}

// A ready, still-undecided variant that landed after the review — a reroll's output or
// a brand-new shot's first generation. `reviewedId` (the variant the review saw, if any)
// is excluded so the reviewed one itself never counts; a shot absent from the review
// passes `undefined`, so every ready variant qualifies. Gating on `readyAt` rather than
// mere existence excludes leftover candidates that predate the review, while still
// catching one reserved before it but finishing after.
function hasFreshUnreviewedReady(
  variants: Record<string, VariantState>,
  reviewedId: string | undefined,
  reviewCreatedAt: string,
): boolean {
  return Object.entries(variants).some(
    ([vid, v]) =>
      v.file !== null &&
      v.status === "none" &&
      vid !== reviewedId &&
      v.readyAt != null &&
      v.readyAt > reviewCreatedAt,
  );
}

// A materialized leaf (composition / stem) changed since the review. Its primary signal is the
// content baseline the review snapshots (`context.contentHashes`): a leaf has no reviewed variant
// id — it materializes only on accept — so a definition edit or an upstream take swap only shows as
// its live content hash diverging from what the reviewer saw or heard. A live `null` (the leaf still
// exists but its inputs no longer resolve) counts as changed; a leaf dropped from the definition is
// never reached — its caller gate skips it and its address is no longer a valid note target anyway.
// Absent a baseline (a pre-contentHashes record, or a leaf the review never saw) it falls back to
// the fresh-materialization / accepted-stale signals.
function leafChangedSinceReview(
  manager: StateManager,
  stageDef: DefinitionLike,
  leafAddress: string,
  record: ReviewRecord,
): boolean {
  const baseline = record.context.contentHashes?.[leafAddress];
  if (baseline != null) {
    const live = materializedLeafContentHash(
      manager,
      stageDef as unknown as VideoDefinition,
      leafAddress,
    );
    return live == null || live !== baseline;
  }
  const variants = manager.tryGetAssetState(leafAddress)?.variants ?? {};
  return (
    hasFreshUnreviewedReady(variants, undefined, record.createdAt) ||
    isAcceptedStale(manager, leafAddress, definitionHashForAddress(stageDef, leafAddress))
  );
}

// Asset paths whose review-worthy state moved since `record`, so the scaffold can
// seed a note for each. Three signals, because the resolved variant alone hides
// the common reroll case: (1) the resolved variant id changed; (2) a fresh
// unreviewed ready variant became ready *after* the review (a reroll's output, or a
// brand-new shot added since — accepted-still-wins resolution keeps (2) invisible to
// (1)); (3) the accepted variant went stale.
// A shot's composition is a reserved asset (materialized at review submit, not in
// `shot.assets`), so a fourth signal covers it: it fires when a fresh materialization
// landed after the review (a new or re-rendered shot), or when the accepted variant —
// the baseline captured at submit — goes stale from a shotFn or upstream input edit.
export function collectChangedAddresses(
  shots: Array<{
    id: string;
    assets: Record<string, unknown>;
    shotFn?: unknown;
    stemRefs?: readonly string[];
    narrationStemRefs?: readonly string[];
  }>,
  stage: ShotStage,
  manager: StateManager,
  stageDef: DefinitionLike,
  record: ReviewRecord,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (shotId: string, assetName: string) => {
    const assetPath = formatAddress(stage, shotId, assetName);
    if (seen.has(assetPath)) return;
    seen.add(assetPath);
    ordered.push(assetPath);
  };

  // The soundtrack beds — read off whichever stage this is (the reference DefinitionLike carries
  // none, so the field is absent). Their presence is what mints that stage's `timeline#stem`, and
  // both composition stages have one.
  const timelineSoundtracks = (stageDef as unknown as { timelineSoundtracks?: readonly unknown[] })
    .timelineSoundtracks;

  // Timeline (stage-level, non-shot) assets are outside `shots`, so the loops below never
  // reach them — the same structural gap that hid bgm / sizzle beds from the scaffold. The
  // three signals mirror the reference pool (which is likewise flat): the review baseline is
  // `record.context.timeline` (assetName -> variantId), and a bed whose resolved variant moved,
  // that got a fresh unreviewed ready variant, or whose accepted variant went stale, gets a note.
  const timelinePaths: string[] = [];
  const reviewedTimeline = record.context.timeline ?? {};
  for (const assetName of Object.keys(stageDef.topLevelAssets ?? {})) {
    const addr = formatTimelineAddress(stage, assetName);
    const variants = manager.tryGetAssetState(addr)?.variants;
    if (!variants) continue;
    const reviewedId = reviewedTimeline[assetName];
    const resolved = manager.resolveReference(addr);
    const resolvedChanged = resolved != null && resolved.variantId !== reviewedId;
    const acceptedStale = isAcceptedStale(manager, addr, definitionHashForAddress(stageDef, addr));
    if (
      resolvedChanged ||
      hasFreshUnreviewedReady(variants, reviewedId, record.createdAt) ||
      acceptedStale
    ) {
      timelinePaths.push(formatTimelineAssetPath(stage, assetName));
    }
  }

  if (
    (timelineSoundtracks?.length ?? 0) > 0 &&
    leafChangedSinceReview(manager, stageDef, formatTimelineStemAddress(stage), record)
  ) {
    timelinePaths.push(formatTimelineAssetPath(stage, STEM_ASSET_NAME));
  }

  // The overlay is a leaf: its baseline is the content hash the review recorded.
  if ((stageDef as unknown as StageDefinition).overlay) {
    const address = formatTimelineOverlayAddress(stage);
    if (leafChangedSinceReview(manager, stageDef, address, record)) timelinePaths.push(address);
  }

  const changes = computeChangeInfo(resolveCurrentVariantsByShot(shots, stage, manager), record);
  for (const shot of changes?.changedShots ?? []) {
    for (const assetName of Object.keys(shot.changedAssets)) add(shot.shotId, assetName);
  }

  const reviewedByShot = new Map(record.context.shots.map((s) => [s.shotId, s.variants]));
  for (const shot of shots) {
    // A shot absent from the review was added to the definition after it, so it has no
    // baseline — but that's exactly a shot the note should cover, not skip. Treat the
    // missing baseline as empty: signal (1) needs one and already skipped this shot
    // upstream, while (2)/(3) don't, so every fresh variant still qualifies.
    const reviewed = reviewedByShot.get(shot.id) ?? {};
    for (const assetName of Object.keys(shot.assets)) {
      const addr = formatAddress(stage, shot.id, assetName);
      const variants = manager.tryGetAssetState(addr)?.variants;
      if (!variants) continue;
      const acceptedStale = isAcceptedStale(
        manager,
        addr,
        definitionHashForAddress(stageDef, addr),
      );
      if (
        hasFreshUnreviewedReady(variants, reviewed[assetName], record.createdAt) ||
        acceptedStale
      ) {
        add(shot.id, assetName);
      }
    }
  }

  // The per-shot materialized leaves live outside `shot.assets`, so the loops above never reach
  // them: a shot's composition, and its audio stems when the shot has cues. Both are caught by the
  // content-hash baseline diff (or its fallback) in `leafChangedSinceReview`.
  for (const shot of shots) {
    if (
      shot.shotFn &&
      leafChangedSinceReview(manager, stageDef, formatCompositionAddress(stage, shot.id), record)
    ) {
      add(shot.id, COMPOSITION_ASSET_NAME);
    }
    for (const stem of listShotStems(stage, shot)) {
      if (leafChangedSinceReview(manager, stageDef, stem.address, record)) {
        add(shot.id, assetNameOf(parseAddress(stem.address)));
      }
    }
  }

  return [...timelinePaths, ...ordered];
}

// The first review has no baseline to diff against, so "changed" is meaningless —
// every asset is new. Seed them all (the same set the diff considers: per-shot
// assets + video compositions) so the agent fills the lines it cares about and
// deletes the rest, identical to the steady-state workflow. Without this the agent
// would hand-type addresses on round one — exactly the typo risk the scaffold exists
// to remove.
export function collectAllAddresses(
  shots: Array<{
    id: string;
    assets: Record<string, unknown>;
    shotFn?: unknown;
    stemRefs?: readonly string[];
    narrationStemRefs?: readonly string[];
  }>,
  stage: ShotStage,
  topLevelAssets?: DefinitionLike["topLevelAssets"],
  timelineSoundtracks?: readonly unknown[],
  plateIds?: readonly string[],
  hasOverlay?: boolean,
): string[] {
  const ordered: string[] = [];
  for (const setupId of plateIds ?? []) ordered.push(formatPlateAssetPath(setupId));
  for (const assetName of Object.keys(topLevelAssets ?? {})) {
    ordered.push(formatTimelineAssetPath(stage, assetName));
  }
  if (hasOverlay) ordered.push(formatTimelineOverlayAddress(stage));
  if ((timelineSoundtracks?.length ?? 0) > 0) {
    ordered.push(formatTimelineAssetPath(stage, STEM_ASSET_NAME));
  }
  for (const shot of shots) {
    for (const assetName of Object.keys(shot.assets)) {
      ordered.push(formatAddress(stage, shot.id, assetName));
    }
    if (shot.shotFn) {
      ordered.push(formatAddress(stage, shot.id, COMPOSITION_ASSET_NAME));
    }
    for (const stem of listShotStems(stage, shot)) ordered.push(stem.address);
  }
  return ordered;
}

// Reference is a flat pool (no shots): the review's baseline variants live in
// `record.context.timeline` (assetName -> variantId), so the same three signals as
// `collectChangedAddresses` — resolved variant moved, a fresh unreviewed ready variant
// became ready after the review, or the accepted variant went stale — apply per reviewable
// reference asset.
// Asset paths are already `reference:<name>`, the note address shape.
export function collectChangedReferenceAddresses(
  reference: ReferenceDefinition,
  manager: StateManager,
  record: ReviewRecord,
): string[] {
  const ordered: string[] = [];
  const reviewed = record.context.timeline ?? {};
  for (const assetPath of listReviewableAssetPaths(reference, "reference")) {
    const assetName = assetPath.slice("reference:".length);
    const addr = formatReferenceAddress(assetName);
    const variants = manager.tryGetAssetState(addr)?.variants;
    if (!variants) continue;
    const reviewedId = reviewed[assetName];
    const resolved = manager.resolveReference(addr);
    const resolvedChanged = resolved != null && resolved.variantId !== reviewedId;
    const acceptedStale = isAcceptedStale(manager, addr, definitionHashForAddress(reference, addr));
    if (
      resolvedChanged ||
      hasFreshUnreviewedReady(variants, reviewedId, record.createdAt) ||
      acceptedStale
    ) {
      ordered.push(assetPath);
    }
  }
  return ordered;
}

export function collectAllReferenceAddresses(reference: ReferenceDefinition): string[] {
  return listReviewableAssetPaths(reference, "reference");
}

// The direction is media-less — no variants to diff — so "changed since the review"
// is a part-hash diff: the review record snapshots every part's hash at submit
// (`context.directionParts`, keyed by full `direction:<part>` address), and a part whose hash
// moved — or that the review never saw — gets a seeded note. A record without the baseline
// degrades to seeding every part, same as the first-review path.
export function collectChangedDirectionAddresses(
  direction: Direction,
  record: ReviewRecord,
): string[] {
  const baseline = record.context.directionParts ?? {};
  const ordered: string[] = [];
  for (const [address, hash] of directionPartHashes(direction)) {
    if (baseline[address] !== hash) ordered.push(address);
  }
  return ordered;
}

export function collectAllDirectionAddresses(direction: Direction): string[] {
  return [...directionPartHashes(direction).keys()];
}

// An address missing its `<stage>:` prefix is the stage's own when the prefixed form is one.
// `changedAddresses` is read only to name the intended targets when an address is refused.
export async function resolveAuthoredNotes(
  authored: HandoffNote[],
  stage: string,
  allAddresses: string[],
  changedAddresses: () => Promise<string[] | null>,
): Promise<HandoffNote[]> {
  const valid = new Set(allAddresses);
  const notes = authored.map((n) =>
    !valid.has(n.address) && valid.has(`${stage}:${n.address}`)
      ? { ...n, address: `${stage}:${n.address}` }
      : n,
  );
  const unknown = notes.map((n) => n.address).filter((a) => !valid.has(a));
  if (unknown.length > 0) {
    // The changed set is almost always the intended target, so lead with it; fall back to
    // the full authorable set when nothing changed or there is no review to diff.
    const changed = (await changedAddresses()) ?? [];
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `Unknown handoff note address(es): ${unknown.join(", ")} — use one ` +
        (changed.length ? "changed since the review" : "of the valid note addresses"),
      (changed.length ? changed : allAddresses).map((a) => `  ${a}`),
    );
  }
  return notes;
}

export type HandoffSubject =
  | { stage: "direction"; direction: Direction }
  | { stage: "reference"; reference: ReferenceDefinition }
  | { stage: "animatic" | "video"; animatic: AnimaticDefinition; video: VideoDefinition };

// Writes the handoff under `review/<stage>/handoffs/` and returns its path, or null when the agent
// left none. Nothing is written when an address is refused.
export async function writeHandoff(
  videoRoot: string,
  subject: HandoffSubject,
  authored: HandoffNote[],
  summary: string | undefined,
): Promise<string | null> {
  if (authored.length === 0 && !summary) return null;
  const { stage } = subject;

  let allAddresses: string[];
  let changedAddresses: () => Promise<string[] | null>;
  if (subject.stage === "direction") {
    const { direction } = subject;
    allAddresses = collectAllDirectionAddresses(direction);
    changedAddresses = async () => {
      const record = await loadLatestReviewRecord(videoRoot, "direction-preview");
      return record ? collectChangedDirectionAddresses(direction, record) : null;
    };
  } else if (subject.stage === "reference") {
    const { reference } = subject;
    allAddresses = collectAllReferenceAddresses(reference);
    changedAddresses = async () => {
      const record = await loadLatestReviewRecord(videoRoot, "reference-preview");
      if (!record) return null;
      await applyResolutionDefinitions({ videoRoot });
      const manager = await StateManager.load(videoRoot);
      return collectChangedReferenceAddresses(reference, manager, record);
    };
  } else {
    const reel = subject.stage === "animatic" ? subject.animatic : subject.video;
    const reelStage = subject.stage;
    allAddresses = collectAllAddresses(
      reel.shots,
      reelStage,
      reel.topLevelAssets,
      reel.timelineSoundtracks,
      reelStage === "animatic"
        ? (subject.animatic.exposedPlateIds ?? Object.keys(subject.animatic.plates ?? {}))
        : undefined,
      !!reel.overlay,
    );
    changedAddresses = async () => {
      const record = await loadLatestReviewRecord(
        videoRoot,
        reelStage === "animatic" ? "animatic-preview" : "video-preview",
      );
      if (!record) return null;
      // Resolves addresses, so it must name what the pages showed.
      await applyResolutionDefinitions({ videoRoot });
      const manager = await StateManager.load(videoRoot);
      return collectChangedAddresses(reel.shots, reelStage, manager, reel, record);
    };
  }

  const notes = await resolveAuthoredNotes(authored, stage, allAddresses, changedAddresses);
  const handoff: Omit<Handoff, "id"> = { stage, ...(summary ? { summary } : {}), notes };
  const dir = path.join(videoRoot, REVIEW_DIR, stage, "handoffs");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${buildTimestamp()}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(handoff, null, 2)}\n`, "utf-8");
  return filePath;
}
