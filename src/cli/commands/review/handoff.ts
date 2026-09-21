import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
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
  formatTimelineStemAddress,
  listReviewableAssetPaths,
  listShotStems,
  parseAddress,
  parseStageScope,
  STEM_ASSET_NAME,
} from "../../../core/address.js";
import {
  definitionHashForAddress,
  materializedLeafContentHash,
} from "../../../core/composition-resource.js";
import { directionPartHashes } from "../../../core/direction-hash.js";
import type { Direction } from "../../../core/dsl/direction.js";
import { KonteError } from "../../../core/errors.js";
import { STAGE_ENTRY_FILE } from "../../../core/roots.js";
import { computeChangeInfo } from "../../../core/review-diff.js";
import {
  buildTimestamp,
  loadLatestReviewRecord,
  REVIEW_DIR,
  type ReviewRecord,
} from "../../../core/review-record.js";
import { isAcceptedStale } from "../../../core/staleness.js";
import { StateManager } from "../../../core/state/index.js";
import type { HandoffNote } from "../../../core/types/handoff.js";
import type {
  ReferenceDefinition,
  VariantState,
  VideoDefinition,
} from "../../../core/types/index.js";
import { loadDirectionIfPresent, loadVideoAndAnimatic } from "../../load-definition.js";
import { loadReference } from "../../../core/loader.js";
import { requireVideoRoot } from "../../context.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

type Stage = "animatic" | "video" | "reference";

function renderHandoff(notes: HandoffNote[], stage: Stage | "direction", summary: string): string {
  return `${JSON.stringify({ stage, summary, notes }, null, 2)}\n`;
}

// `--note "<address>=<text>"` — split on the first `=`, since an address never contains one
// but note prose might. A missing separator is a usage error, not an empty-text note.
function parseNoteOption(value: string, previous: HandoffNote[]): HandoffNote[] {
  const eq = value.indexOf("=");
  if (eq === -1) {
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
): string[] {
  const ordered: string[] = [];
  for (const setupId of plateIds ?? []) ordered.push(formatPlateAssetPath(setupId));
  for (const assetName of Object.keys(topLevelAssets ?? {})) {
    ordered.push(formatTimelineAssetPath(stage, assetName));
  }
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

export function registerHandoffCommand(review: Command): void {
  const handoff = review.command("handoff").description("Handoff notes shown in the review UI");
  handoff
    .command("new <stage>")
    .description("Write a handoff file for a stage (video, animatic, reference, or direction)")
    .option(
      "--note <address=text>",
      'Authored note as "<address>=<text>"; repeatable. Writes a complete handoff in one shot (no scaffold to Read+Edit); an unknown address is rejected with the changed set',
      parseNoteOption,
      [] as HandoffNote[],
    )
    .option("--summary <text>", "Handoff summary line")
    .addHelpText(
      "after",
      `
Diffs the latest review against current state and seeds a note per changed asset.
Without --note it writes a scaffold (empty text) to fill in; with --note it writes
those authored notes directly, so the agent loop is one command instead of three.
A scaffold with nothing to seed is not written.

Examples:
  konte review handoff new video                               scaffold the changed assets
  konte review handoff new video --summary "reworked shot 02" \\
    --note video:shot.02.motion="minimized motion to stop drift" \\
    --note video:timeline.bgm="fit bed to 16s"                  author notes in one shot`,
    )
    .action(async (scope: string, opts: { note: HandoffNote[]; summary?: string }) => {
      const videoRoot = requireVideoRoot();

      // The stage-scope selects which review stream to diff against: a review exists per stage.
      const { stage } = parseStageScope(scope);

      // `allAddresses` is every authorable note address (the validation set); `changedAddresses`
      // is the diff against the latest review (null when there is no review to diff). The scaffold
      // seeds the diff (falling back to all on the first review); author mode validates against all
      // and surfaces the diff as the hint on a bad address.
      let allAddresses: string[];
      let changedAddresses: string[] | null;
      let record: ReviewRecord | null;

      // Every branch below but `direction` resolves addresses, and must name what the pages showed.
      if (stage !== "direction") await applyResolutionDefinitions({ videoRoot });

      if (stage === "direction") {
        // Media-less: the diff is against the part-hash baseline in the latest review record,
        // not variants — so neither state nor the stage definitions are loaded here.
        const direction = await loadDirectionIfPresent(videoRoot);
        if (!direction) {
          throw new KonteError("ADDRESS_NOT_FOUND", "No direction.ts found in project");
        }
        record = await loadLatestReviewRecord(videoRoot, "direction-preview");
        allAddresses = collectAllDirectionAddresses(direction);
        changedAddresses = record ? collectChangedDirectionAddresses(direction, record) : null;
      } else if (stage === "reference") {
        // Reference is a flat pool of assets — its own definition file, no shots, no compositions.
        const reference = await loadReference(videoRoot);
        const manager = await StateManager.load(videoRoot);
        record = await loadLatestReviewRecord(videoRoot, "reference-preview");
        allAddresses = collectAllReferenceAddresses(reference);
        changedAddresses = record
          ? collectChangedReferenceAddresses(reference, manager, record)
          : null;
      } else {
        const { video, animatic } = await loadVideoAndAnimatic(videoRoot);
        const manager = await StateManager.load(videoRoot);
        const stageDef = stage === "animatic" ? animatic : video;
        if (!stageDef) {
          throw new KonteError(
            "INVALID_ADDRESS",
            `No ${STAGE_ENTRY_FILE.animatic} found in project`,
          );
        }

        const mode = stage === "animatic" ? "animatic-preview" : "video-preview";
        record = await loadLatestReviewRecord(videoRoot, mode);

        const shots = stage === "animatic" ? animatic.shots : video.shots;
        allAddresses = collectAllAddresses(
          shots,
          stage,
          stageDef.topLevelAssets,
          (stage === "animatic" ? animatic : video)?.timelineSoundtracks,
          stage === "animatic"
            ? (animatic.exposedPlateIds ?? Object.keys(animatic.plates ?? {}))
            : undefined,
        );
        changedAddresses = record
          ? collectChangedAddresses(shots, stage, manager, stageDef, record)
          : null;
      }

      const seeded = changedAddresses ?? allAddresses;
      const authored = opts.note;

      let notes: HandoffNote[];
      if (authored.length > 0) {
        const valid = new Set(allAddresses);
        const unknown = authored.map((n) => n.address).filter((a) => !valid.has(a));
        if (unknown.length > 0) {
          // The changed set is almost always the intended target, so lead with it; fall back to
          // the full authorable set when nothing changed or there is no review to diff.
          const changed = changedAddresses ?? [];
          const hint = changed.length
            ? `Changed since the review:\n${changed.map((a) => `  ${a}`).join("\n")}`
            : `Valid note addresses:\n${allAddresses.map((a) => `  ${a}`).join("\n")}`;
          throw new KonteError(
            "ADDRESS_NOT_FOUND",
            `Unknown handoff note address(es): ${unknown.join(", ")}\n${hint}`,
          );
        }
        notes = authored;
      } else {
        notes = seeded.map((address) => ({ address, text: "" }));
      }

      // A scaffold with nothing to seed would be an empty file the agent must still open only to
      // find it useless — so skip the write and say why. Author mode always writes (the notes are
      // the point), even if the diff found nothing.
      if (authored.length === 0 && notes.length === 0) {
        console.error(record ? "No changes since the review." : "No assets to seed.");
        return;
      }

      const dir = path.join(videoRoot, REVIEW_DIR, stage, "handoffs");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${buildTimestamp()}.json`);
      await fs.writeFile(filePath, renderHandoff(notes, stage, opts.summary ?? ""), "utf-8");

      console.log(filePath);
    });
}
