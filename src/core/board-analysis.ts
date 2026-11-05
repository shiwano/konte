import { acceptedVariantId } from "./accepted-variant.js";
import {
  type ShotStage,
  formatReferenceAddress,
  formatPlateAddress,
  tryParseAddress,
  isPlateAddress,
  formatViewAddress,
} from "./address.js";
import { isImagedView, parseViewName, type View } from "./view.js";
import type { PinWindow, VideoShotPins } from "./direction-check.js";
import type { PinOccurrence } from "./pin-check.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import {
  type AssetDefinition,
  isPendingAnimaticShot,
  isPendingShot,
  type ReferenceDefinition,
  type AnimaticDefinition,
  type PanelDefinition,
  type PanelLane,
  type ShotDefinition,
  type VideoDefinition,
} from "./types/index.js";

import { harvestShotPictureCues } from "./composition-builder.js";
import { definitionHashForAddress } from "./composition-resource.js";
import type { AnimaticSetupState } from "./direction-check.js";
import {
  collectShotFrames,
  setupView,
  type SongVariantState,
  type StagingStageState,
} from "./direction.js";
import type { Direction } from "./dsl/direction.js";
import { extractRefs, exposedPlateIdsOf, LANES, lanePanels, platesOf } from "./graph.js";
import { loadAnimatic, loadVideoDefinition } from "./loader.js";
import { songVariantState } from "./song-variant.js";
import { stageEntryPath } from "./roots.js";
import { StateManager } from "./state/index.js";

/**
 * One camera frame the direction places on a board shot: which lane of which shot, on which setup.
 */
type BoardFrame = { shotId: string; lane: PanelLane; setup: string };

// Where a keyframe stands on nothing. Two gaps over one walk, since both ask the same question of
// the same chain — what a picture was built FROM:
//
//   - a PLATE that reaches no `reference:<location>`.
//   - a SHOT that reaches neither its setup's plate nor, where the setup has none, its location
//     reference.
//
// Wiring, not fidelity: it answers whether the anchor is an input the picture was built from.
// Whether the prompt then NAMES that picture is the prompt critic's and the reviewer's business.
//
// A SHOT with no generative step is exempt: a `jsxImage` screen or a `file` frame has one outcome,
// so there is nothing for an anchor to hold still, and it counts toward no plate either.
//
// A PLATE is exempt on a narrower condition — a chain that never touches the reference stage. What
// the author hands over whole, konte cannot look inside: a `file` plate cut from the place offline
// and one cut from nothing are the same bytes here, so the demand would be unanswerable. A plate
// DERIVED from the reference stage answers it — `imageCrop` of the wrong sheet is as invented a place
// as a generated plate that took none.
//
// The walk is the animatic's own; anything else it hits (a `reference:` sheet) is a leaf here.
//
// A `pendingShot` is skipped: it declares nothing, so there is nothing for it to have ignored.
//
// A cutin is one more shot on its setup: its keyframes are read against that setup's anchor, and a
// deterministic one drops out of the plate demand the same way.
//
// A view image of the location counts as the location. Where the setup's `view` is known, a picture
// that reaches the location but not its own view's image (`front`: the master itself) is a gap of
// its own: a plate, or a shot on a setup with no plate.
type SetupAnchorGaps = {
  // Setup ids whose plate stands on no location reference — bar one built from no reference at all.
  unanchoredPlates: string[];
  // Shot ids that reach neither anchor, keyed by the setup they sit on.
  unanchoredShots: Map<string, string[]>;
  // The same, where every keyframe of each frame that reaches neither is signed off; a shot with an
  // unsigned frame is in `unanchoredShots` alone.
  signedOffUnanchoredShots: Map<string, string[]>;
  // Setup ids whose plate reaches its location through another view's image only.
  unviewedPlates: string[];
  // Shot ids on a setup with no plate that reach their location through another view's image only.
  unviewedShots: Map<string, string[]>;
  // Developed frames with no generative step, keyed by setup, so the plate demand can drop them too.
  // A `pendingShot` is not among them: it declares nothing yet, so it still counts toward a plate.
  deterministicShots: Map<string, number>;
  // Generated frames whose every keyframe is signed off, keyed by setup.
  signedOffShots: Map<string, number>;
  // Setup ids whose plate has no generative step.
  deterministicPlates: string[];
};

export function listSetupAnchorGaps(
  animatic: AnimaticDefinition,
  frames: readonly BoardFrame[],
  locationBySetup: ReadonlyMap<string, string>,
  viewBySetup: ReadonlyMap<string, View> = new Map(),
  signedOff: (address: string) => boolean = () => false,
): SetupAnchorGaps {
  const plates = platesOf(animatic);
  const entryOf = animaticEntryResolver(animatic);
  const viewImageOf = (setupId: string, location: string): string | undefined => {
    const view = viewBySetup.get(setupId);
    if (view === undefined) return undefined;
    return isImagedView(view)
      ? formatViewAddress(location, view)
      : formatReferenceAddress(location);
  };

  const unanchoredPlates: string[] = [];
  const unviewedPlates: string[] = [];
  const deterministicPlates: string[] = [];
  for (const setupId of Object.keys(plates)) {
    // An unknown setup id is the direction's own finding (`unused-setup` / a plate keyed off-roster);
    // reporting it again as unanchored would name the wrong fix.
    const location = locationBySetup.get(setupId);
    if (location === undefined) continue;
    const viewImage = viewImageOf(setupId, location);
    const walk = walkPictureChain(
      [formatPlateAddress(setupId)],
      formatReferenceAddress(location),
      entryOf,
      viewImage,
    );
    if ((walk.generative || walk.touchedReference) && !walk.reached) unanchoredPlates.push(setupId);
    if (walk.reached && viewImage !== undefined && !walk.reachedView) unviewedPlates.push(setupId);
    if (!walk.generative) deterministicPlates.push(setupId);
  }

  const unviewedShots = new Map<string, string[]>();
  const unanchoredShots = new Map<string, string[]>();
  const signedOffUnanchoredShots = new Map<string, string[]>();
  const deterministicShots = new Map<string, number>();
  const signedOffShots = new Map<string, number>();
  const shotById = new Map(animatic.shots.map((shot) => [shot.id, shot]));
  for (const frame of frames) {
    const shot = shotById.get(frame.shotId);
    if (shot === undefined || isPendingAnimaticShot(shot)) continue;
    const setupId = frame.setup;
    const location = locationBySetup.get(setupId);
    // The plate supersedes: where one exists it IS the frame, and a shot feeding the raw location
    // instead has taken the unframed anchor for the framed one.
    const target =
      setupId in plates
        ? formatPlateAddress(setupId)
        : location !== undefined
          ? formatReferenceAddress(location)
          : undefined;
    if (target === undefined) continue;

    // Rooted at the PANELS alone — the keyframes are what these findings are about. Not the shot's
    // declared pool, and not `compositionRefs` either, which carries every layer the shot renders:
    // an overlay or a sound that happens to take the anchor says nothing about the frame the keyframe
    // was drawn on. Everything legitimately reachable — a shot asset the panel consumes, a timeline
    // asset, a `shot(…)` chain — is reached from a panel.
    const viewImage =
      setupId in plates || location === undefined ? undefined : viewImageOf(setupId, location);
    const panels = lanePanels(shot, frame.lane).map((panel) => panel.address);
    const walk = walkPictureChain(panels, target, entryOf, viewImage);
    if (!walk.generative) {
      deterministicShots.set(setupId, (deterministicShots.get(setupId) ?? 0) + 1);
      continue;
    }
    const signed = panels.every(signedOff);
    if (signed) signedOffShots.set(setupId, (signedOffShots.get(setupId) ?? 0) + 1);
    const gaps = !walk.reached
      ? signed
        ? signedOffUnanchoredShots
        : unanchoredShots
      : viewImage !== undefined && !walk.reachedView
        ? unviewedShots
        : undefined;
    if (!gaps) continue;
    const shots = gaps.get(setupId) ?? [];
    if (!shots.includes(shot.id)) shots.push(shot.id);
    gaps.set(setupId, shots);
  }

  for (const [setupId, shots] of signedOffUnanchoredShots) {
    const unsigned = unanchoredShots.get(setupId) ?? [];
    const signed = shots.filter((id) => !unsigned.includes(id));
    if (signed.length > 0) signedOffUnanchoredShots.set(setupId, signed);
    else signedOffUnanchoredShots.delete(setupId);
  }

  return {
    unanchoredPlates,
    unanchoredShots,
    signedOffUnanchoredShots,
    unviewedPlates,
    unviewedShots,
    deterministicShots,
    signedOffShots,
    deterministicPlates,
  };
}

/**
 * One `imageCrop` as the nesting check reads it: the address it cuts and the window it takes, in that
 * source's own pixels.
 */
type CropWindow = {
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
};

export function cropWindowOf(inputs: Record<string, unknown>): CropWindow | null {
  const image = typeof inputs.image === "string" ? parsePlaceholder(inputs.image) : null;
  const geometry = ["x", "y", "width", "height", "outWidth", "outHeight"].map((key) => inputs[key]);
  if (!image || image === "seed" || geometry.some((n) => typeof n !== "number")) return null;
  const [x, y, width, height, outWidth, outHeight] = geometry as number[];
  return {
    image,
    x: x!,
    y: y!,
    width: width!,
    height: height!,
    outWidth: outWidth!,
    outHeight: outHeight!,
  };
}

// Every crop behind a picture, nearest first — breadth-first, so "the crop closest to the plate" is
// the first one out.
function cropsInChain(
  root: string,
  entryOf: (address: string) => AssetDefinition | undefined,
): CropWindow[] {
  const seen = new Set<string>();
  const queue = [root];
  const out: CropWindow[] = [];
  for (let at = 0; at < queue.length; at++) {
    const address = queue[at]!;
    if (seen.has(address)) continue;
    seen.add(address);
    const entry = entryOf(address);
    if (!entry) continue;
    if (entry.kind === "local" && entry.operation === "crop") {
      const window = cropWindowOf(entry.inputs);
      if (window) out.push(window);
    }
    queue.push(...extractRefs(entry));
  }
  return out;
}

/**
 * Where a closer frame's plate is not built from the plate of the frame it declares itself `within`.
 *
 * `within` says this frame is a step in along a wider one's axis; the plates have to say the same,
 * or the scale of the set is re-invented per plate and a `close` comes back at a `medium`'s
 * distance. Either of two forms in the plate's chain satisfies it:
 *
 * - A CUT: a `readsPrevPanel` step handed the parent plate as is, which draws the step in as a cut
 *   from that frame — the camera moves, so perspective and eye height change as a real move in does.
 * - A WINDOW: a strictly smaller crop, straight out of the parent plate (the form a generated parent
 *   leaves) or out of whatever master the parent plate itself cuts, inside the parent's window — a
 *   zoom from the parent's camera position.
 *
 * Silent where either plate is absent: the demand would name a file that is not there.
 *
 * Wiring, not fidelity, as on `listSetupAnchorGaps`: nothing on an adapter says which input a model
 * takes its framing from, so a plate handed the master AND a nested crop passes here, and a cut is
 * not measured for how far in it went. What reads either as the wrong size is the critic's
 * `off-framing`, and the accept of the panels drawn on it.
 */
// Per `readsPrevPanel` address, every source passed as is to one of its image inputs.
function cutSources(animatic: AnimaticDefinition): Map<string, Set<string>> {
  const readers = new Set(animatic.prevPanelReaders ?? []);
  const out = new Map<string, Set<string>>();
  for (const input of animatic.imageInputs ?? []) {
    if (!readers.has(input.address)) continue;
    const sources = out.get(input.address) ?? new Set<string>();
    for (const source of input.sources) sources.add(source);
    out.set(input.address, sources);
  }
  return out;
}

// The parent plate's own frame, where the definition states it: a crop is rendered at its
// `outWidth`/`outHeight`. A generated or handed-over plate has no size on the graph, and the canvas
// is a guess that would report a legal window as a gap.
function parentFrameSize(plate: AssetDefinition): { width: number; height: number } | undefined {
  if (plate.kind !== "local" || plate.operation !== "crop") return undefined;
  const own = cropWindowOf(plate.inputs);
  return own ? { width: own.outWidth, height: own.outHeight } : undefined;
}

export function listSetupNestGaps(
  animatic: AnimaticDefinition,
  withinBySetup: ReadonlyMap<string, string>,
): string[] {
  const plates = platesOf(animatic);
  const entryOf = animaticEntryResolver(animatic);
  const cutFrom = cutSources(animatic);
  const out: string[] = [];
  for (const [id, parentId] of withinBySetup) {
    if (!(id in plates) || !(parentId in plates)) continue;
    const parentAddress = formatPlateAddress(parentId);
    const chain = chainAddresses([formatPlateAddress(id)], entryOf);
    if ([...chain].some((address) => cutFrom.get(address)?.has(parentAddress))) continue;
    const crops = cropsInChain(formatPlateAddress(id), entryOf);
    // Cutting the parent plate itself. The window is in the PARENT's pixels, so it is read against
    // the PARENT's frame — never the child's own output size, which is a scale. With no stated frame
    // the crop stands: `x`/`y` are non-negative by construction.
    const frame = parentFrameSize(plates[parentId]!);
    if (
      crops.some(
        (c) =>
          c.image === parentAddress &&
          (!frame ||
            (c.x + c.width <= frame.width &&
              c.y + c.height <= frame.height &&
              (c.width < frame.width || c.height < frame.height))),
      )
    ) {
      continue;
    }
    // Cutting the same master the parent cuts. The parent's own window is the nearest crop behind
    // it; containment in that implies containment in its parent's, so a chain of windows nests by
    // induction.
    const parent = cropsInChain(parentAddress, entryOf)[0];
    if (
      parent &&
      crops.some(
        (c) =>
          c.image === parent.image &&
          c.x >= parent.x &&
          c.y >= parent.y &&
          c.x + c.width <= parent.x + parent.width &&
          c.y + c.height <= parent.y + parent.height &&
          (c.width < parent.width || c.height < parent.height),
      )
    ) {
      continue;
    }
    out.push(id);
  }
  return out;
}

function statedFrameSize(entry: AssetDefinition): { width: number; height: number } | undefined {
  if (entry.kind !== "local" || entry.operation !== "resize") return parentFrameSize(entry);
  const { width, height } = entry.inputs;
  return typeof width === "number" && typeof height === "number" ? { width, height } : undefined;
}

// A crop on the path from a panel back to its plate — not the plate's own crop of its master, which
// the plate address itself is, nor one taking the whole of a source whose frame the graph states.
// With no stated frame the crop stands, as under `plate-unnested`.
function recropsPlate(
  chain: ReadonlySet<string>,
  plate: string,
  entryOf: (address: string) => AssetDefinition | undefined,
): boolean {
  return [...chain].some((address) => {
    if (address === plate) return false;
    const entry = entryOf(address);
    if (entry?.kind !== "local" || entry.operation !== "crop") return false;
    if (!chainAddresses([address], entryOf).has(plate)) return false;
    const window = cropWindowOf(entry.inputs);
    const source = window ? entryOf(window.image) : undefined;
    const frame = source ? statedFrameSize(source) : undefined;
    return !(
      window &&
      frame &&
      window.x === 0 &&
      window.y === 0 &&
      window.width >= frame.width &&
      window.height >= frame.height
    );
  });
}

/**
 * A keyframe on a plated setup that crops the plate on its way in.
 */
export type PlateRecrop = {
  setupId: string;
  shotId: string;
  lane: PanelLane;
  panel: string;
};

// The plate is the setup's frame, so a window of it is a frame the direction never declared, and
// the setup's `holds` no longer say what is in it. No generative step is required: a panel that is
// the crop itself shows the same undeclared frame.
export function listPlateRecrops(
  animatic: AnimaticDefinition,
  frames: readonly BoardFrame[],
): PlateRecrop[] {
  const plates = platesOf(animatic);
  const entryOf = animaticEntryResolver(animatic);
  const shotById = new Map(animatic.shots.map((shot) => [shot.id, shot]));
  const out: PlateRecrop[] = [];
  for (const frame of frames) {
    const shot = shotById.get(frame.shotId);
    if (shot === undefined || isPendingAnimaticShot(shot)) continue;
    if (!(frame.setup in plates)) continue;
    const plate = formatPlateAddress(frame.setup);
    for (const { address } of lanePanels(shot, frame.lane)) {
      if (!recropsPlate(chainAddresses([address], entryOf), plate, entryOf)) continue;
      out.push({ setupId: frame.setup, shotId: shot.id, lane: frame.lane, panel: address });
    }
  }
  return out;
}

/**
 * The conditioning text one keyframe stands on — the panel's own positive prompts and those of every
 * step behind it. Panels come out in panel order.
 */
type PanelPromptText = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  texts: string[];
  generative: boolean;
};

// What `subject-unnamed` reads. The CHAIN, not the panel alone: a keyframe cut from an earlier one
// inherits the naming that one did, and a wrapper panel carries no text of its own. The negative
// half excludes rather than names, and a spoken line is words said inside the frame, so
// `positivePromptsAt` is what each step contributes.
export function listPanelPromptText(animatic: AnimaticDefinition): PanelPromptText[] {
  const entryOf = animaticEntryResolver(animatic);
  const out: PanelPromptText[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      for (const panel of lanePanels(shot, lane)) {
        const texts: string[] = [];
        for (const address of chainAddresses([panel.address], entryOf)) {
          texts.push(...positivePromptsAt(animatic, address));
        }
        out.push({
          shotId: shot.id,
          lane,
          panel: panel.address,
          texts,
          generative: walkReferenceReach(panel.address, entryOf).generative,
        });
      }
    }
  }
  return out;
}

/**
 * The positive prompts each returned plate is generated with, keyed by setup id: its own, and those
 * of the intermediates it is built from. The walk stops at another returned plate. Every returned
 * plate has an entry; one whose chain reads no prompt — a crop of the master, a file handed over
 * whole — has an empty one.
 */
export function listPlateTexts(animatic: AnimaticDefinition): Record<string, string[]> {
  const entryOf = animaticEntryResolver(animatic);
  const ids = exposedPlateIdsOf(animatic);
  const plates = new Set(ids.map((id) => formatPlateAddress(id)));
  return Object.fromEntries(
    ids.map((id) => {
      const plate = formatPlateAddress(id);
      const chain = orderedChainAddresses([plate], entryOf, (a) => a !== plate && plates.has(a));
      return [id, chain.flatMap((address) => positivePromptsAt(animatic, address))];
    }),
  );
}

/**
 * The `reference:<id>` assets each developed animatic shot puts on screen as they are, keyed by shot
 * id: reached from the shot's picture through no generative step.
 */
export function listShownReferences(animatic: AnimaticDefinition): Record<string, string[]> {
  const entryOf = animaticEntryResolver(animatic);
  const out: Record<string, string[]> = {};
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    const seen = new Set<string>();
    const refs: string[] = [];
    const stack = [...(shot.pictureRefs ?? [])];
    while (stack.length > 0) {
      const address = stack.pop()!;
      if (seen.has(address)) continue;
      seen.add(address);
      const parsed = tryParseAddress(address);
      if (parsed?.stage === "reference" && parsed.kind === "reference") {
        if (!refs.includes(parsed.assetName)) refs.push(parsed.assetName);
        continue;
      }
      const entry = entryOf(address);
      if (!entry || entry.deterministic !== true) continue;
      stack.push(...extractRefs(entry));
    }
    if (refs.length > 0) out[shot.id] = refs;
  }
  return out;
}

/**
 * Which prompts make each keyframe: one entry per `<Panel>` usage, with the addresses behind it that
 * declare a positive prompt, in declaration order.
 */
export type PanelConditioning = {
  shotId: string;
  lane: PanelLane;
  // The panel's place in its lane, 1-based: `index` of `of`.
  index: number;
  of: number;
  panel: string;
  conditioning: string[];
};

// Structural so a listing can pass the definition it already loaded.
type PanelConditioningSource = AnimaticPictureSource & {
  prompts?: readonly { address: string; negative?: boolean; spoken?: boolean }[];
};

// A panel name is the author's and a wrapper carries no text of its own, so which prompt writes a
// shot's opening frame is not readable off the addresses. The chain crosses shots, the timeline and
// the plates; an address outside this stage declares no prompt here, so it drops out. A plate stays
// whatever it is built with: a crop carries no prompt, yet it is the frame the panel stands on.
export function listPanelConditioning(animatic: PanelConditioningSource): PanelConditioning[] {
  const entryOf = animaticEntryResolver(animatic);
  const written = new Set(
    (animatic.prompts ?? []).filter((p) => !p.negative && !p.spoken).map((p) => p.address),
  );
  const out: PanelConditioning[] = [];
  for (const shot of animatic.shots) {
    if (shot.pending === true) continue;
    for (const lane of LANES) {
      const panels = (lane === "main" ? shot.panels : shot.cutin?.panels) ?? [];
      panels.forEach((panel, i) => {
        out.push({
          shotId: shot.id,
          lane,
          index: i + 1,
          of: panels.length,
          panel: panel.address,
          conditioning: orderedChainAddresses([panel.address], entryOf).filter(
            (address) => written.has(address) || isPlateAddress(address),
          ),
        });
      });
    }
  }
  return out;
}

// Every address one picture's chain reaches, the root itself included.
function chainAddresses(
  roots: readonly string[],
  entryOf: (address: string) => AssetDefinition | undefined,
): Set<string> {
  return new Set(orderedChainAddresses(roots, entryOf));
}

// The same walk, kept in declaration order: the root, then each input as the definition passes it.
// An address `stopAt` matches is neither listed nor walked through.
function orderedChainAddresses(
  roots: readonly string[],
  entryOf: (address: string) => AssetDefinition | undefined,
  stopAt?: (address: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (address: string): void => {
    if (seen.has(address)) return;
    seen.add(address);
    if (stopAt?.(address)) return;
    out.push(address);
    const entry = entryOf(address);
    if (entry) for (const ref of extractRefs(entry)) visit(ref);
  };
  for (const root of roots) visit(root);
  return out;
}

// The conditioning text one panel carries. The negative half excludes rather than defines, and a
// spoken line is words said inside the frame, so neither describes it.
function positivePromptsAt(
  animatic: Pick<AnimaticDefinition, "prompts">,
  address: string,
): string[] {
  return (animatic.prompts ?? [])
    .filter((p) => p.address === address && !p.negative && !p.spoken)
    .map((p) => p.value);
}

/**
 * The shot's own assets each of its frames reaches, walked from what that frame draws: the cutin's
 * from what `<Cutin>` alone draws and its keyframes, the main frame's from every other composition
 * ref and its keyframes. An asset both reach — one take drawn in both, a shared upstream — is in both.
 * Only `stage:shot.<id>.*` addresses are walked.
 */
export function shotLaneChains(
  stage: ShotStage,
  shot: Pick<ShotDefinition, "id" | "assets" | "compositionRefs" | "panels" | "cutin">,
): Record<PanelLane, Set<string>> {
  const own = (address: string) => {
    const parsed = tryParseAddress(address);
    return parsed?.stage === stage && parsed.kind === "shot" && parsed.shotId === shot.id;
  };
  const walk = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = roots.filter(own);
    while (stack.length > 0) {
      const address = stack.pop()!;
      if (seen.has(address)) continue;
      seen.add(address);
      const parsed = tryParseAddress(address);
      const entry = parsed?.kind === "shot" ? shot.assets[parsed.assetName] : undefined;
      if (entry) stack.push(...extractRefs(entry).filter(own));
    }
    return seen;
  };
  const cutinRefs = new Set(shot.cutin?.refs ?? []);
  const shared = new Set(shot.cutin?.sharedRefs ?? []);
  return {
    main: walk([
      ...(shot.compositionRefs ?? []).filter((ref) => !cutinRefs.has(ref) || shared.has(ref)),
      ...(shot.panels ?? []).map((p) => p.address),
    ]),
    cutin: walk([...cutinRefs, ...(shot.cutin?.panels ?? []).map((p) => p.address)]),
  };
}

export function listVideoPasserInputs(
  video: VideoDefinition,
  animatic: AnimaticDefinition,
  cuesOf: (shotId: string) => readonly PictureCueLike[] | null,
): {
  shotId: string;
  lane: PanelLane;
  refs: string[];
  texts: string[];
  generative: boolean;
}[] {
  const videoEntry = videoEntryResolver(video);
  const boardEntry = animaticEntryResolver(animatic);
  const entryOf = (address: string) => videoEntry(address) ?? boardEntry(address);
  const out: ReturnType<typeof listVideoPasserInputs> = [];
  for (const shot of video.shots) {
    if (isPendingShot(shot)) continue;
    const cutinRefs = new Set(shot.cutin?.refs ?? []);
    const shared = new Set(shot.cutin?.sharedRefs ?? []);
    const pictureRefs = shot.pictureRefs ?? shot.compositionRefs ?? [];
    const videoRefs = new Set((cuesOf(shot.id) ?? []).map((cue) => cue.src));
    for (const lane of LANES) {
      const roots =
        lane === "cutin"
          ? [...cutinRefs]
          : pictureRefs.filter((ref) => !cutinRefs.has(ref) || shared.has(ref));
      for (const root of roots) {
        if (!videoRefs.has(root)) continue;
        const videoReach = walkReferenceReach(root, videoEntry);
        out.push({
          shotId: shot.id,
          lane,
          refs: walkReferenceReach(root, entryOf).refs,
          texts: [...chainAddresses([root], videoEntry)].flatMap((address) =>
            positivePromptsAt(video, address),
          ),
          generative: videoReach.generative,
        });
      }
    }
  }
  return out;
}

// Which frames each DEVELOPED video shot pins, per lane, the seam half of `join-unpinned`. `pins` is
// collected as the stage builds (`pin-collect.ts`), so an address here is a declaration site, not
// what it resolves to.
//
// A pin counts for every frame whose chain reaches its asset (`shotLaneChains`). A pin neither frame
// reaches is the main frame's. What a pin holds is read down the video's own chain — a board panel
// wrapped in a resize declared here still pins that panel.
export function listVideoShotPins(
  video: VideoDefinition,
  cuesOf?: (shotId: string) => readonly PictureCueLike[] | null,
  signedOff?: (address: string) => boolean,
): VideoShotPins[] {
  const byFrame = new Map<
    string,
    VideoShotPins & { pins: VideoShotPins["pins"][number][]; slots: ("start" | "end")[] }
  >();
  const chains = new Map<string, Record<PanelLane, Set<string>>>();
  for (const shot of video.shots) {
    if (isPendingShot(shot)) continue;
    byFrame.set(`${shot.id}/main`, { shotId: shot.id, lane: "main", pins: [], slots: [] });
    chains.set(shot.id, shotLaneChains("video", shot));
    if (!shot.cutin) continue;
    byFrame.set(`${shot.id}/cutin`, { shotId: shot.id, lane: "cutin", pins: [], slots: [] });
  }
  const entryOf = videoEntryResolver(video);
  for (const pin of video.pins ?? []) {
    const parsed = tryParseAddress(pin.address);
    if (parsed?.kind !== "shot") continue;
    const chain = chains.get(parsed.shotId);
    const reached = LANES.filter((lane) => chain?.[lane].has(pin.address));
    // A slot is evidence about the take a lane RENDERS, so it counts only where that lane's chain
    // reaches its asset: an alternate declared beside the take says nothing about what the take can
    // carry. A wired pin keeps its older credit to `main` when no lane reaches it.
    for (const lane of reached) byFrame.get(`${parsed.shotId}/${lane}`)?.slots.push(pin.pin);
    if (pin.source === undefined) continue;
    const reaches = [...orderedChainAddresses([pin.source], entryOf)];
    const shotSec = video.shots.find((s) => s.id === parsed.shotId)?.duration;
    const window =
      cuesOf && shotSec !== undefined
        ? pinWindow(pin, shotSec, cuesOf(parsed.shotId) ?? [])
        : undefined;
    for (const lane of reached.length > 0 ? reached : (["main"] as const)) {
      byFrame.get(`${parsed.shotId}/${lane}`)?.pins.push({
        pin: pin.pin,
        input: pin.input,
        reaches,
        ...(pin.referable ? { referable: true as const } : {}),
        ...(signedOff?.(pin.address) ? { signedOff: true as const } : {}),
        ...(window ? { window } : {}),
      });
    }
  }
  return [...byFrame.values()];
}

type PictureCueLike = {
  src: string;
  start: number | null;
  duration: number | null;
  mediaStart: number | null;
  playbackRate?: number | null;
};

// Fallback frame for a take whose adapter declares no clock.
const DEFAULT_FRAME_SEC = 1 / 24;

// The `<Video>` playing the pinned take directly at the end the pin names: the earliest one for a
// start, the latest-ending one for an end. A take reached only through a wrapper (a trim) is not
// located.
function pinWindow(
  pin: PinOccurrence,
  shotSec: number,
  cues: readonly PictureCueLike[],
): PinWindow | undefined {
  const clipSec = pin.clip?.sec;
  const windows = cues
    .filter((c) => c.src === pin.address)
    .map((c) => {
      const opensAt = c.start ?? 0;
      const from = c.mediaStart ?? 0;
      const rate = c.playbackRate ?? 1;
      // The shot cuts at its end whatever the cue declares, and the take runs out at its own.
      let played = Math.min(c.duration ?? shotSec - opensAt, shotSec - opensAt);
      if (clipSec !== undefined) played = Math.min(played, (clipSec - from) / rate);
      return { opensAt, closesAt: opensAt + played, from, to: from + played * rate };
    });
  if (windows.length === 0) return undefined;
  const pick =
    pin.pin === "start"
      ? windows.reduce((a, b) => (b.opensAt < a.opensAt ? b : a))
      : windows.reduce((a, b) => (b.closesAt > a.closesAt ? b : a));
  return {
    address: pin.address,
    shotSec,
    ...pick,
    ...(clipSec !== undefined ? { clipSec } : {}),
    ...(pin.clip ? { landsAt: pin.clip.landsAt } : {}),
    frameSec: pin.clip?.frameSec ?? DEFAULT_FRAME_SEC,
  };
}

// One address → its declaration, over the video's timeline and shots. A board or reference address
// resolves to nothing: it is a leaf of the video's own chain.
function videoEntryResolver(
  video: VideoDefinition,
): (address: string) => AssetDefinition | undefined {
  return (address) => {
    const parsed = tryParseAddress(address);
    if (!parsed || parsed.stage !== "video") return undefined;
    if (parsed.kind === "timeline") return video.topLevelAssets?.[parsed.assetName];
    if (parsed.kind === "shot") {
      return video.shots.find((s) => s.id === parsed.shotId)?.assets[parsed.assetName];
    }
    return undefined;
  };
}

/**
 * How each developed board shot meets the shot before it: the two keyframes that answer for a seam,
 * and what the opening one was handed of the frame it cuts from.
 */
type ShotContinuity = {
  shotId: string;
  lane: PanelLane;
  // The keyframe answering for the cut INTO this shot, and the one the next shot cuts from — the
  // same first/last split `lineup` and `lineupTo` are read at.
  firstPanel: string;
  lastPanel: string;
  // Some step behind the first keyframe is drawn by a `readsPrevPanel` adapter.
  carries: boolean;
  // Every address the other shots' panels passed to those steps reach.
  linked: string[];
};

// A shot with no panels — a pending one, a board aside — answers nothing and is left out; so does a
// lane with none, which is a graphic shot's main frame. Each lane is its own camera and answers its
// own seam. Listed whether or not any adapter reads a previous panel: `join-unpinned` reads the
// opening keyframe off a board that carries none at all.
export function listShotContinuity(animatic: AnimaticDefinition): ShotContinuity[] {
  const readers = new Set(animatic.prevPanelReaders ?? []);
  const entryOf = animaticEntryResolver(animatic);
  const prevPanels = prevPanelSources(animatic);

  const out: ShotContinuity[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      const panels = lanePanels(shot, lane).map((panel) => panel.address);
      const firstPanel = panels[0];
      const lastPanel = panels[panels.length - 1];
      if (firstPanel === undefined || lastPanel === undefined) continue;
      const lineage = keyframeLineage(firstPanel, shot.id, entryOf);
      const sources = lineage.flatMap((address) => [...(prevPanels.get(address) ?? [])]);
      out.push({
        shotId: shot.id,
        lane,
        firstPanel,
        lastPanel,
        carries: lineage.some((address) => readers.has(address)),
        linked: sources.length > 0 ? [...chainAddresses(sources, entryOf)] : [],
      });
    }
  }
  return out;
}

// Per `readsPrevPanel` address, the sources of its image inputs that are another shot's panel,
// passed as is — what `promptReferenceTags`' `prevPanel` check sees. A wrapped panel, and any other
// asset of another shot, is an ordinary input.
function prevPanelSources(animatic: AnimaticDefinition): Map<string, Set<string>> {
  const readers = new Set(animatic.prevPanelReaders ?? []);
  const panels = new Set(
    animatic.shots.flatMap((shot) =>
      LANES.flatMap((lane) => lanePanels(shot, lane).map((panel) => panel.address)),
    ),
  );
  const out = new Map<string, Set<string>>();
  for (const input of animatic.imageInputs ?? []) {
    if (!readers.has(input.address)) continue;
    const reader = tryParseAddress(input.address);
    const shotId = reader?.stage === "animatic" && reader.kind === "shot" ? reader.shotId : null;
    for (const source of input.sources) {
      if (!panels.has(source)) continue;
      const parsed = tryParseAddress(source);
      if (parsed?.stage !== "animatic" || parsed.kind !== "shot" || parsed.shotId === shotId) {
        continue;
      }
      const sources = out.get(input.address) ?? new Set<string>();
      sources.add(source);
      out.set(input.address, sources);
    }
  }
  return out;
}

// The keyframe and the steps it is wrapped in — this shot's OWN assets, and no further. A wrapper
// is drawn by no model of its own, so the panel address alone would call a linked shot unlinked;
// but a plate, a sheet and the panel of another shot are conditioning this keyframe stands on, and
// a previous panel one of THOSE reads answers for its own seam, not for this one.
function keyframeLineage(
  panel: string,
  shotId: string,
  entryOf: (address: string) => AssetDefinition | undefined,
): string[] {
  const own = (address: string) => {
    const parsed = tryParseAddress(address);
    return parsed?.stage === "animatic" && parsed.kind === "shot" && parsed.shotId === shotId;
  };
  const seen = new Set<string>();
  const stack = [panel];
  while (stack.length > 0) {
    const address = stack.pop()!;
    if (seen.has(address)) continue;
    seen.add(address);
    const entry = entryOf(address);
    if (entry) stack.push(...extractRefs(entry).filter(own));
  }
  return [...seen];
}

/** One keyframe's `reference:<id>` slots, in the order that panel's own inputs declare them. */
type PanelReferenceSlots = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  slots: string[];
};

// The reference images each developed animatic shot hands its panels — the slot order
// `slot-order-mismatch` compares against the shot's declared lineup. Read off each panel asset
// separately, and off the panel itself rather than the chain behind it: what decides which subject a
// model puts where is the order that one call's inputs arrive in, so two panels of one shot are two
// orders and merging them would both hide a reversed second panel and invent an order out of two
// single-subject frames. Panels come out in panel order — the first answers for the shot's `lineup`,
// the last for its `lineupTo`.
export function listPanelReferenceSlots(animatic: AnimaticDefinition): PanelReferenceSlots[] {
  const entryOf = animaticEntryResolver(animatic);
  const out: PanelReferenceSlots[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      for (const panel of lanePanels(shot, lane)) {
        // A keyframe may be a shot asset, a timeline asset or a plate — all three are one call whose
        // input order decides where a subject lands.
        const entry = entryOf(panel.address);
        if (!entry) continue;
        const slots: string[] = [];
        for (const ref of extractRefs(entry)) {
          const target = tryParseAddress(ref);
          if (!target || target.stage !== "reference" || target.kind !== "reference") continue;
          if (slots.includes(target.assetName)) continue;
          slots.push(target.assetName);
        }
        if (slots.length > 0) out.push({ shotId: shot.id, lane, panel: panel.address, slots });
      }
    }
  }
  return out;
}

/**
 * One keyframe's reference REACH — every `reference:<id>` the chain behind that panel stands on.
 * Panels come out in panel order.
 */
type PanelReferenceReach = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  // A SET in list form, in no meaningful order — the order that decides where a subject lands is
  // `listPanelReferenceSlots`'.
  refs: string[];
  // False when nothing in the chain generates — a `file` keyframe, a trim of one.
  generative: boolean;
};

// The references each developed animatic shot's keyframes stand on — what `character-unconsumed`
// reads. Unlike `listPanelReferenceSlots`, this walks the CHAIN behind each panel rather than its own
// inputs: a keyframe drawn from an earlier keyframe carries that frame's subjects in the picture.
export function listPanelReferenceReach(animatic: AnimaticDefinition): PanelReferenceReach[] {
  const entryOf = animaticEntryResolver(animatic);
  const out: PanelReferenceReach[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      for (const panel of lanePanels(shot, lane)) {
        out.push({
          shotId: shot.id,
          lane,
          panel: panel.address,
          ...walkReferenceReach(panel.address, entryOf),
        });
      }
    }
  }
  return out;
}

// A `reference:<id>` is a leaf: what is behind a reference sheet is the sheet's business.
function walkReferenceReach(
  root: string,
  entryOf: (address: string) => AssetDefinition | undefined,
): { refs: string[]; generative: boolean } {
  const seen = new Set<string>();
  const refs: string[] = [];
  const stack = [root];
  let generative = false;
  while (stack.length > 0) {
    const address = stack.pop()!;
    if (seen.has(address)) continue;
    seen.add(address);
    const parsed = tryParseAddress(address);
    if (parsed?.stage === "reference" && parsed.kind === "reference") {
      if (!refs.includes(parsed.assetName)) refs.push(parsed.assetName);
      continue;
    }
    const entry = entryOf(address);
    if (!entry) continue;
    if (entry.deterministic !== true) generative = true;
    stack.push(...extractRefs(entry));
  }
  return { refs, generative };
}

// What a walk over the animatic's pictures reads: where each address's declaration lives, and the
// keyframes each shot declares.
type AnimaticPictureSource = {
  shots: readonly {
    id: string;
    assets: Record<string, AssetDefinition>;
    pending?: boolean;
    panels?: readonly PanelDefinition[];
    cutin?: { panels?: readonly PanelDefinition[] } | null;
  }[];
  topLevelAssets?: Record<string, AssetDefinition>;
};

// One address → its declaration, over the animatic's plates, timeline and shots.
function animaticEntryResolver(
  animatic: AnimaticPictureSource,
): (address: string) => AssetDefinition | undefined {
  const plates = platesOf(animatic);
  return (address) => {
    const parsed = tryParseAddress(address);
    if (!parsed || parsed.stage !== "animatic") return undefined;
    if (parsed.kind === "plate") return plates[parsed.assetName];
    if (parsed.kind === "timeline") return animatic.topLevelAssets?.[parsed.assetName];
    if (parsed.kind === "shot") {
      return animatic.shots.find((s) => s.id === parsed.shotId)?.assets[parsed.assetName];
    }
    return undefined;
  };
}

// One walk over a picture's inputs, answering both halves at once: whether `target` is in the chain,
// and whether anything in it generates. Never short-circuits on `reached` — `generative` is only
// true of the whole chain once the whole chain has been seen.
//
// A view image of a location (`reference:view.<id>.<view>`) is that location: reaching one reaches
// `reference:<id>`. `view`, where given, is the one image `reachedView` asks for exactly.
function walkPictureChain(
  roots: readonly string[],
  target: string,
  entryOf: (address: string) => AssetDefinition | undefined,
  view?: string,
): { reached: boolean; reachedView: boolean; generative: boolean; touchedReference: boolean } {
  const seen = new Set<string>();
  const stack = [...roots];
  let reached = false;
  let reachedView = false;
  let generative = false;
  let touchedReference = false;
  while (stack.length > 0) {
    const address = stack.pop()!;
    if (address === target || `reference:${parseViewName(address)?.location}` === target) {
      reached = true;
    }
    if (address === view) reachedView = true;
    if (seen.has(address)) continue;
    seen.add(address);
    // Before the entry lookup: a reference asset is a leaf on this walk, so it has none here.
    const parsed = tryParseAddress(address);
    if (parsed?.stage === "reference" && parsed.kind === "reference") touchedReference = true;
    const entry = entryOf(address);
    if (!entry) continue;
    if (entry.deterministic !== true) generative = true;
    stack.push(...extractRefs(entry));
  }
  return { reached, reachedView, generative, touchedReference };
}

// The view images in the reference pool that are built from no `reference:<location>` of their
// own location, as `<locationId>.<view>`. A view handed over whole (a `file`) is exempt.
export function listViewAnchorGaps(reference: {
  topLevelAssets?: Record<string, AssetDefinition>;
}): string[] {
  const assets = reference.topLevelAssets ?? {};
  const entryOf = (address: string): AssetDefinition | undefined => {
    const parsed = tryParseAddress(address);
    return parsed?.stage === "reference" && parsed.kind === "reference"
      ? assets[parsed.assetName]
      : undefined;
  };
  const out: string[] = [];
  for (const name of Object.keys(assets)) {
    const view = parseViewName(name);
    if (!view) continue;
    const own = assets[name]!;
    const walk = walkPictureChain(extractRefs(own), formatReferenceAddress(view.location), entryOf);
    const generative = walk.generative || own.deterministic !== true;
    if ((generative || walk.touchedReference) && !walk.reached) {
      out.push(`${view.location}.${view.view}`);
    }
  }
  return out;
}

// What the setups class reads off the board: which setups have a plate, which plates stand on no
// location reference, and which developed shots reach neither anchor.
export function animaticSetupState(
  direction: Direction,
  animatic: AnimaticDefinition,
  reference: ReferenceDefinition | null,
  manager: StateManager | null,
): AnimaticSetupState {
  const state = manager?.getState() ?? null;
  const setups = direction.setups ?? {};
  const locationBySetup = new Map(Object.entries(setups).map(([id, s]) => [id, s.location]));
  const viewBySetup = new Map(
    Object.keys(setups).flatMap((id) => {
      const view = setupView(setups, id);
      return view ? [[id, view] as const] : [];
    }),
  );
  const gaps = listSetupAnchorGaps(
    animatic,
    collectShotFrames(direction),
    locationBySetup,
    viewBySetup,
    (address) => manager !== null && isSignedOff(manager, animatic, address),
  );
  // Only the declared windows: a root (`within: null`) and an undeclared one are cut from whatever
  // they like.
  const withinBySetup = new Map(
    Object.entries(direction.setups ?? {}).flatMap(([id, s]) =>
      typeof s.within === "string" ? [[id, s.within] as const] : [],
    ),
  );
  const plateIds = animatic.exposedPlateIds ?? Object.keys(animatic.plates ?? {});
  return {
    plateIds,
    unanchoredPlateIds: gaps.unanchoredPlates,
    unnestedPlateIds: listSetupNestGaps(animatic, withinBySetup),
    unconsumedBy: gaps.unanchoredShots,
    signedOffUnconsumedBy: gaps.signedOffUnanchoredShots,
    deterministicShotsPerSetup: gaps.deterministicShots,
    signedOffShotsPerSetup: gaps.signedOffShots,
    deterministicPlateIds: gaps.deterministicPlates,
    unviewedPlateIds: gaps.unviewedPlates,
    unviewedBy: gaps.unviewedShots,
    unanchoredViews: reference ? listViewAnchorGaps(reference) : [],
    acceptedPlateIds: plateIds.filter(
      (id) => state != null && acceptedVariantId(state, formatPlateAddress(id)) !== null,
    ),
  };
}

// The stage-side half of the staging class: the order the board hands each keyframe its references
// in, and how each shot on a plated setup carries its plate.
export function stagingStageState(
  direction: Direction,
  animatic: AnimaticDefinition,
  video: VideoDefinition | null,
  manager: StateManager | null,
): StagingStageState {
  const frames = collectShotFrames(direction);
  const passers = frames.some((f) => (f.passing?.length ?? 0) > 0);
  const signedOff = (address: string) =>
    manager !== null && isSignedOff(manager, animatic, address);
  const mark = (address: string) => (signedOff(address) ? { signedOff: true as const } : {});
  const plateTexts = listPlateTexts(animatic);
  return {
    panelSlots: listPanelReferenceSlots(animatic),
    panelReach: listPanelReferenceReach(animatic).map((p) => ({ ...p, ...mark(p.panel) })),
    plateRecrops: listPlateRecrops(animatic, frames),
    panelPrompts: listPanelPromptText(animatic).map((p) => ({ ...p, ...mark(p.panel) })),
    plateTexts,
    signedOffPlateIds: Object.keys(plateTexts).filter((id) => signedOff(formatPlateAddress(id))),
    shownReferences: listShownReferences(animatic),
    videoPins: video
      ? listVideoShotPins(
          video,
          (id) => harvestShotPictureCues(video, id),
          manager ? (address) => isSignedOff(manager, video, address) : undefined,
        )
      : [],
    ...(passers && video
      ? {
          videoPassers: listVideoPasserInputs(video, animatic, (id) =>
            harvestShotPictureCues(video, id),
          ),
        }
      : {}),
    shotPanels: listShotContinuity(animatic).map((p) => ({ ...p, ...mark(p.firstPanel) })),
  };
}

// An accept whose inputs alone moved stands.
function isSignedOff(
  manager: StateManager,
  def: VideoDefinition | AnimaticDefinition,
  address: string,
): boolean {
  return manager.acceptedAsDefined(address, definitionHashForAddress(def, address));
}

type DirectionStageInputs = {
  animaticSetups: AnimaticSetupState | undefined;
  stagingStage: StagingStageState | undefined;
  songVariant: SongVariantState | undefined;
};

// What `checkDirection` reads off the stages and state, read tolerantly. The setups and staging
// halves are **undefined when the board could not be read**, and that distinction is the contract:
// an unreadable board cannot owe plates, while a readable one that declares none owes every plate its
// shared setups call for. Mirrors `reference?.exposedAssetNames` at the same call sites.
export async function loadDirectionStageInputs(
  videoRoot: string,
  direction: Direction,
  reference: ReferenceDefinition | null,
): Promise<DirectionStageInputs> {
  const animatic = await loadAnimatic(videoRoot).catch(() => null);
  const video = animatic
    ? await loadVideoDefinition(stageEntryPath(videoRoot, "video")).catch(() => null)
    : null;
  const manager = await StateManager.load(videoRoot).catch(() => null);
  return {
    animaticSetups: animatic
      ? animaticSetupState(direction, animatic, reference, manager)
      : undefined,
    stagingStage: animatic ? stagingStageState(direction, animatic, video, manager) : undefined,
    songVariant: manager ? songVariantState(manager, direction) : undefined,
  };
}
