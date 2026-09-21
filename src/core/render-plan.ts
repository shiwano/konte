import {
  audioLevelling,
  type AudioLevelling,
  loudnessOf,
  shotCueLevels,
  type CueKind,
  type ShotCueLevels,
} from "./audio-level.js";
import type { AudioLoudness } from "./audio-loudness.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import type {
  PanelDefinition,
  TimelineFunction,
  Typography,
  VideoFormat,
} from "./types/definition.js";
import type { ShotFunction } from "./dsl/shot-context.js";
import type { ShotStage } from "./address.js";
import {
  formatAddress,
  formatAssetPath,
  formatTimelineAddress,
  tryParseAddress,
} from "./address.js";
import { resolveCompositionRef } from "./composition-refs.js";
import { KonteError } from "./errors.js";
import { inferMediaType } from "./media-type.js";
import { formatStaleReason, variantsNewestFirst } from "./staleness.js";
import type { StateManager } from "./state/index.js";
import { type AssetState, type StageDefinition, isPendingShot } from "./types/index.js";

export interface ShotRenderPlan {
  // The stage this shot belongs to. Carried per shot, not only on the plan, because a video plan's
  // stand-in shots render out of the animatic's plan and each half must format its own addresses.
  stage: ShotStage;
  shotId: string;
  duration: number;
  shotFn: ShotFunction | null;
  // ANIMATIC ONLY: the shot's keyframes and their windows, so `<Panel>` knows the slot it holds.
  panels?: readonly PanelDefinition[];
  // ANIMATIC ONLY: the same for the keyframes inside the shot's `<Cutin>`.
  cutinPanels?: readonly PanelDefinition[];
  // VIDEO ONLY: whether this shot draws the animatic shot of the same id in place of its own
  // picture — the stand-in for a shot whose delivered composition cannot be drawn yet. Display
  // only: it carries no address, no node and no verdict. See BuildRenderPlanOptions.standIn.
  showStandIn: boolean;
  // An undeveloped shot (the injected pendingShot): no composition/asset to resolve. Preview
  // renders it as a black tile carrying the direction's `action`; export refuses while any remain.
  pending: boolean;
  // A shot that occupies the clock without being a shot of the arc. On the video it has a `shotFn`
  // like any other shot; on the animatic it has none, and the renderers fill its span with
  // `asideSlugHtml`.
  aside: boolean;
  action: string;
  resolvedFiles: Record<string, string>;
  resolvedVariants: Record<string, string>;
  // The shot definition's `cueKinds` and `pictureRefs`, carried through so no later reader re-reads
  // the direction. A cue in both is a clip's own track (see shotCueLevels).
  cueKinds?: Readonly<Record<string, CueKind>>;
  pictureRefs?: readonly string[];
  // Each cue's levelling gain and sfx lead-in by address (see shotCueLevels), resolved against the
  // same variants this plan picked. Every render site re-keys it to its own srcs.
  cueLevels?: ShotCueLevels;
  fallbackFile: string | null;
  fallbackType: "video" | "image" | null;
  warnings: string[];
  unacceptedAssets: string[];
  // Asset names that have no resolvable file yet (only populated with `allowNotReady`).
  // Each is `<name> — <reason>` so the UI can show what a shot is still waiting on.
  notReadyAssets: string[];
  // The composition's refs OUTSIDE this shot — an animatic panel, a reference asset, another shot's
  // asset. `unacceptedAssets`/`notReadyAssets` only ever covered the shot's own assets, so nothing
  // gated these: an unresolvable one used to render as a raw placeholder, i.e. a black layer. The
  // plan only reports; the export gate decides (a preview happily renders around a missing ref).
  unacceptedRefs: string[];
  unresolvedRefs: string[];
}

export interface RenderPlan {
  stage: ShotStage;
  fps: number;
  typography: Typography;
  size: { width: number; height: number };
  // The working format the plan was built at (size/fps). `size` above may be mutated to a delivery
  // resolution during export; `format` stays the working canvas the timeline fn is invoked with.
  format: VideoFormat;
  shots: ShotRenderPlan[];
  outputDir: string;
  timelineResolvedFiles: Record<string, string>;
  timelineResolvedVariants: Record<string, string>;
  timelineFn: TimelineFunction | null;
  unacceptedTimelineAssets: string[];
  timelineNotReadyAssets: string[];
  // Each bed's level by `soundtrack()` id, resolved against the take this plan picked: the
  // levelling gain, and the loudness a duck aims off. Read by BOTH the preview's bed elements and
  // the export's mux.
  bedLevels: Record<string, BedLevel>;
  // VIDEO ONLY: the animatic's own plan, for the shots showing a stand-in. Null when none was
  // supplied (every path but a video preview).
  standInPlan: RenderPlan | null;
}

export interface BuildRenderPlanOptions {
  shotId?: string;
  outputDir: string;
  allowUnaccepted?: boolean;
  // Preview-only: don't throw when some assets lack a ready variant. Build a partial
  // plan (ready shots resolved, stale-but-present files shown, not-ready ones recorded
  // in notReadyAssets) so a reviewer can watch finished shots while others still
  // generate. Never set on the materialize/export paths — a broken composition must
  // not be rendered or committed.
  allowNotReady?: boolean;
  // VIDEO PREVIEW ONLY: the animatic's own render plan, so a shot whose delivered composition
  // cannot be drawn yet plays its board instead — panels cutting on the shot's clock with the lines
  // over them — and the reel reads at the right length end to end. A stand-in is display only: no
  // address, no node, no verdict. Never passed on the export or thumbnail paths, which must ship
  // what was actually made.
  standIn?: RenderPlan | null;
  // The shots a PAGE was already told are standing in, replacing the question rather than adding to
  // it. Whether a build is drawable reads live state, so a ref landing between the state response
  // and this one would otherwise redraw a shot the page no longer means. Only a request carrying a
  // page snapshot passes it; everything else computes it live.
  pinnedStandInShotIds?: ReadonlySet<string>;
}

// The strict resolver's verdict, for the reason `hasReadyVariant` is: an accept alone is not what
// strict resolution takes. It rejects an accepted take with no file, and one konte accepted itself
// that has since gone stale (`generate` re-bakes that).
function hasAcceptedVariant(address: string, manager: StateManager): boolean {
  return manager.selectVariant(address, { requireAccepted: true }) !== null;
}

// The resolver's own question, put to the resolver rather than re-derived: whatever this passes,
// the render then resolves. Re-derived, the two part — and what the render draws for an address the
// resolver refused is an unresolved `__konte:…__` placeholder.
function hasReadyVariant(
  target: AssetState | undefined,
  address: string,
  manager: StateManager,
): boolean {
  if (!target?.variants) return false;
  return manager.selectVariant(address, { includeStale: false }) !== null;
}

// Why `hasReadyVariant` returned false, per variant — so a "no ready variant"
// failure is diagnosable after the fact instead of a dead end. Per take rather than the resolver's
// one verdict: the point here is to say what is wrong with each.
function describeNotReady(
  target: AssetState | undefined,
  address: string,
  manager: StateManager,
): string {
  const variants = target?.variants;
  if (!variants || Object.keys(variants).length === 0) return "no variants yet";
  const reasons = variantsNewestFirst(variants).map(([variantId, v]) => {
    if (v.file === null) return `${variantId}: no file (status ${v.status})`;
    if (v.status === "dismissed") return `${variantId}: dismissed`;
    const s = manager.variantStaleness(address, variantId);
    return s && (s.inputStale || s.definitionStale)
      ? `${variantId}: ${formatStaleReason(s)}`
      : `${variantId}: ready`;
  });
  return reasons.join(", ");
}

// Each shot's span as a whole number of frames, cut at the frame nearest its edge on the direction's
// clock. A render rounds an off-frame span up, and the error summed over the cut would stretch it.
export function frameAlignedDurations(
  shots: readonly { id: string; duration: number }[],
  fps: number,
): Map<string, number> {
  const durations = new Map<string, number>();
  let clock = 0;
  let edge = 0;
  for (const shot of shots) {
    clock += shot.duration;
    const next = Math.max(edge + 1, Math.round(clock * fps));
    durations.set(shot.id, (next - edge) / fps);
    edge = next;
  }
  return durations;
}

export function buildRenderPlan(
  video: StageDefinition,
  manager: StateManager,
  options: BuildRenderPlanOptions,
): RenderPlan {
  const { shotId, outputDir, allowUnaccepted, allowNotReady } = options;
  const standInPlan = options.standIn ?? null;
  const stage = video.stage;

  // Whether this shot's delivered composition can be drawn at all — the same question the review UI
  // answers for the reviewer, so a shot flips from its stand-in to its real picture the moment its
  // last upstream lands, one shot at a time.
  const buildUnready = (shot: StageDefinition["shots"][number]): boolean =>
    (shot.compositionRefs ?? []).some((ref) => !resolveCompositionRef(manager, ref));

  const showsStandIn = (shot: StageDefinition["shots"][number]): boolean => {
    if (!standInPlan) return false;
    const pinned = options.pinnedStandInShotIds;
    if (pinned) return pinned.has(shot.id);
    if (!standInPlan.shots.some((s) => s.shotId === shot.id && s.shotFn)) return false;
    // An aside is never stood in for: the board has no drawing of it to substitute.
    if (shot.aside === true) return false;
    return isPendingShot(shot) || !shot.shotFn || buildUnready(shot);
  };

  const timelineAddr = (assetName: string): string => formatTimelineAddress(stage, assetName);
  const shotAddr = (shot: StageDefinition["shots"][number], assetName: string): string =>
    formatAddress(stage, shot.id, assetName);

  let targetShots = video.shots;
  if (shotId) {
    targetShots = video.shots.filter((s) => s.id === shotId);
    if (targetShots.length === 0) {
      throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found in video definition`);
    }
  }

  // Partial preview builds a best-effort plan from whatever is ready and records the
  // rest per shot (see notReadyAssets below), so the gate is skipped entirely.
  if (!allowNotReady) {
    const missingAssets: string[] = [];

    const collectMissing = (addr: string): void => {
      const target = manager.getState().assets[addr];
      if (allowUnaccepted) {
        if (!hasReadyVariant(target, addr, manager)) {
          missingAssets.push(`${addr} — ${describeNotReady(target, addr, manager)}`);
        }
      } else if (!hasAcceptedVariant(addr, manager)) {
        missingAssets.push(addr);
      }
    };

    if (video.topLevelAssets) {
      for (const assetName of Object.keys(video.topLevelAssets)) {
        collectMissing(timelineAddr(assetName));
      }
    }

    for (const s of targetShots) {
      if (!s.shotFn) continue;
      for (const [assetName] of Object.entries(s.assets)) {
        collectMissing(shotAddr(s, assetName));
      }
    }
    if (missingAssets.length > 0) {
      if (allowUnaccepted) {
        throw new KonteError(
          "RENDER_PLAN_FAILED",
          `Assets without ready variants:\n  ${missingAssets.join("\n  ")}`,
        );
      } else {
        throw new KonteError(
          "RENDER_PLAN_FAILED",
          `Assets without accepted variants: ${missingAssets.join(", ")}\nHint: use --preview to render with ready (non-accepted) variants`,
        );
      }
    }
  }

  const timelineResolvedFiles: Record<string, string> = {};
  const timelineResolvedVariants: Record<string, string> = {};
  const unacceptedTimelineAssets: string[] = [];
  const timelineNotReadyAssets: string[] = [];
  if (video.topLevelAssets) {
    for (const [assetName] of Object.entries(video.topLevelAssets)) {
      const addr = timelineAddr(assetName);
      if (allowUnaccepted) {
        const result = manager.resolveReference(addr, { includeStale: allowNotReady });
        if (result) {
          timelineResolvedFiles[assetName] = result.file;
          timelineResolvedVariants[assetName] = result.variantId;
          if (!result.isAccepted) {
            unacceptedTimelineAssets.push(addr);
          }
        } else if (allowNotReady) {
          timelineNotReadyAssets.push(
            `${assetName} — ${describeNotReady(manager.getState().assets[addr], addr, manager)}`,
          );
        }
      } else {
        const result = manager.resolveReference(addr, { requireAccepted: true });
        if (result) {
          timelineResolvedFiles[assetName] = result.file;
          timelineResolvedVariants[assetName] = result.variantId;
        }
      }
    }
  }

  const shotPlans: ShotRenderPlan[] = [];
  const frameDurations = frameAlignedDurations(video.shots, video.format.fps);

  for (const shot of targetShots) {
    const plan: ShotRenderPlan = {
      stage,
      shotId: shot.id,
      duration: frameDurations.get(shot.id) ?? shot.duration,
      shotFn: shot.shotFn ?? null,
      ...(shot.panels ? { panels: shot.panels } : {}),
      ...(shot.cutin?.panels ? { cutinPanels: shot.cutin.panels } : {}),
      showStandIn: showsStandIn(shot),
      pending: isPendingShot(shot),
      aside: shot.aside === true,
      action: shot.action,
      resolvedFiles: {},
      resolvedVariants: {},
      ...(shot.cueKinds ? { cueKinds: shot.cueKinds } : {}),
      ...(shot.pictureRefs ? { pictureRefs: shot.pictureRefs } : {}),
      fallbackFile: null,
      fallbackType: null,
      warnings: [],
      unacceptedAssets: [],
      notReadyAssets: [],
      unacceptedRefs: [],
      unresolvedRefs: [],
    };

    if (isPendingShot(shot) || (plan.aside && !shot.shotFn)) {
      // Nothing to resolve: an undeveloped shot has no composition and no assets, and neither does
      // an aside on the stage that does not board it. Preview renders the tile (or the stand-in);
      // for the pending one export refuses upstream (see export.ts), while the aside's span is
      // filled with konte's slug — an aside is finished business, not missing work.
      shotPlans.push(plan);
      continue;
    }

    if (shot.shotFn) {
      for (const [assetName] of Object.entries(shot.assets)) {
        const addr = shotAddr(shot, assetName);
        if (allowUnaccepted) {
          const result = manager.resolveReference(addr, { includeStale: allowNotReady });
          if (result) {
            plan.resolvedFiles[assetName] = result.file;
            plan.resolvedVariants[assetName] = result.variantId;
            if (!result.isAccepted) {
              plan.unacceptedAssets.push(addr);
            }
          } else if (allowNotReady) {
            plan.notReadyAssets.push(
              `${assetName} — ${describeNotReady(manager.getState().assets[addr], addr, manager)}`,
            );
          }
        } else {
          const result = manager.resolveReference(addr, { requireAccepted: true });
          if (result) {
            plan.resolvedFiles[assetName] = result.file;
            plan.resolvedVariants[assetName] = result.variantId;
          }
        }
      }

      // Everything the composition consumes from outside the shot, resolved the way the render will
      // resolve it. Reported, never thrown on — see the field comments.
      const ownPaths = new Set(
        Object.keys(shot.assets).map((name) => formatAssetPath(stage, shot.id, name)),
      );
      for (const ref of shot.compositionRefs ?? []) {
        if (ownPaths.has(ref)) continue;
        const resolved = resolveCompositionRef(manager, ref, { includeStale: allowNotReady });
        if (!resolved) plan.unresolvedRefs.push(ref);
        else if (!resolved.isAccepted) plan.unacceptedRefs.push(resolved.address);
      }
    } else {
      plan.warnings.push(`Shot "${shot.id}" has no composition; using fallback`);

      type FallbackCandidate = {
        address: string;
        assetName: string;
      };
      const candidates: FallbackCandidate[] = [];

      for (const assetName of Object.keys(shot.assets)) {
        const addr = shotAddr(shot, assetName);
        candidates.push({ address: addr, assetName });
      }

      let resolved = false;
      for (const candidate of candidates) {
        if (allowUnaccepted) {
          const result = manager.resolveReference(candidate.address, {
            includeStale: allowNotReady,
          });
          if (result) {
            plan.fallbackFile = result.file;
            plan.fallbackType = inferMediaType(result.file) === "image" ? "image" : "video";
            plan.resolvedVariants[candidate.assetName] = result.variantId;
            if (!result.isAccepted) {
              plan.unacceptedAssets.push(candidate.address);
            }
            resolved = true;
            break;
          }
        } else {
          const result = manager.resolveReference(candidate.address, { requireAccepted: true });
          if (result) {
            const mediaType = inferMediaType(result.file);
            plan.fallbackFile = result.file;
            plan.fallbackType = mediaType === "image" ? "image" : "video";
            plan.resolvedVariants[candidate.assetName] = result.variantId;
            resolved = true;
            break;
          }
        }
      }

      if (!resolved && candidates.length === 0) {
        plan.warnings.push(`Shot "${shot.id}" has no renderable asset`);
      } else if (!resolved && allowNotReady) {
        for (const candidate of candidates) {
          plan.notReadyAssets.push(
            `${candidate.assetName} — ${describeNotReady(manager.getState().assets[candidate.address], candidate.address, manager)}`,
          );
        }
      }
    }

    plan.cueLevels = shotCueLevels({
      stage,
      shotId: shot.id,
      cueKinds: shot.cueKinds,
      pictureRefs: shot.pictureRefs,
      state: manager.getState(),
      resolvedVariants: plan.resolvedVariants,
      timelineResolvedVariants,
      // As the plan's own ref check resolves one, and every renderer substitutes its placeholder.
      resolve: (address) =>
        resolveCompositionRef(manager, address, { includeStale: allowNotReady })?.variantId,
    });

    shotPlans.push(plan);
  }

  return {
    stage,
    fps: video.format.fps,
    typography: video.typography,
    size: video.format.size,
    format: video.format,
    shots: shotPlans,
    outputDir,
    timelineResolvedFiles,
    timelineResolvedVariants,
    timelineFn: video.timelineFn ?? null,
    unacceptedTimelineAssets,
    timelineNotReadyAssets,
    bedLevels: computeBedLevels(video, manager, timelineResolvedVariants),
    standInPlan,
  };
}

/**
 * The one plan a video review runs on. `konte preview video` builds it twice — once to render the
 * page, once to apply the decisions that come back — and the two MUST be built the same way, so
 * neither caller passes options of its own.
 *
 * They diverged once: submit omitted `allowNotReady`, so a video with any not-ready asset (a shot
 * still on its animatic, an unmade BGM) threw there while the page rendered fine. Submit caught the
 * throw, fell through with a null plan, and silently dropped every shot accept while reporting
 * success. Keep this the only way a review plan is built.
 */
export function buildStageReviewPlan(
  definition: StageDefinition,
  manager: StateManager,
  // VIDEO ONLY: the animatic's plan, so an unmade shot plays its board in the reel's place.
  standIn?: RenderPlan | null,
): RenderPlan {
  return buildRenderPlan(definition, manager, {
    outputDir: "",
    // Tolerate not-ready assets: a shot still generating (or a not-yet-made BGM/SFX) must not blank
    // the review UI — nor, on submit, discard the accepts made on the shots that ARE ready.
    allowUnaccepted: true,
    allowNotReady: true,
    ...(standIn ? { standIn } : {}),
  });
}

/** One bed's resolved level: the gain that places it, and the loudness a duck aims off. */
export interface BedLevel {
  gain: number;
  adjustment: AudioLevelling;
  loudness: AudioLoudness | undefined;
}

/**
 * Each bed's level by `soundtrack()` id, against the take currently resolved for it. Recomputed
 * rather than carried whenever the resolution can have moved: a review previewing a different
 * candidate must hear THAT take levelled, and duck to where THAT take lands. An override is
 * honoured whichever way it names the bed's source — by address (a shared asset) or through the
 * timeline map (a timeline-own one).
 */
export function computeBedLevels(
  video: StageDefinition,
  manager: StateManager,
  timelineResolvedVariants: Record<string, string>,
  overrideByAddress?: ReadonlyMap<string, string>,
): Record<string, BedLevel> {
  const levels: Record<string, BedLevel> = {};
  for (const st of video.timelineSoundtracks ?? []) {
    const address = parsePlaceholder(st.src.src);
    if (!address) continue;
    const parsed = tryParseAddress(address);
    // A bed pulling a shared asset (`reference:bgm`) is overridden by address, not through the
    // timeline map — so both are consulted before falling back to what state resolves.
    const overridden =
      overrideByAddress?.get(address) ??
      (parsed?.kind === "timeline" ? timelineResolvedVariants[parsed.assetName] : undefined);
    const variantId = overridden ?? manager.resolveReference(address)?.variantId;
    if (!variantId) continue;
    const loudness = loudnessOf(manager.getState().assets[address]?.variants?.[variantId]?.media);
    const adjustment = audioLevelling("bed", loudness);
    levels[st.id] = { gain: adjustment.gain, adjustment, loudness };
  }
  return levels;
}
