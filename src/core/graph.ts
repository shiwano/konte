import { mixedSoundtracks } from "./song-bed.js";
import {
  type ShotStage,
  COMPOSITION_ASSET_NAME,
  formatAssetPath,
  formatReferenceAssetPath,
  formatPlateAssetPath,
  formatTimelineAssetPath,
  getStage,
  listAssetPaths,
  listReferenceAssetPaths,
  listShotStems,
  NARRATION_STEM_ASSET_NAME,
  SONG_STEM_ASSET_NAME,
  parseAssetPath,
  OVERLAY_ASSET_NAME,
  STEM_ASSET_NAME,
  assetNameOf,
  type DefinitionLike,
  getAssetEntry,
  isMaterializedLeafAssetPath,
  isNarrationStemAddress,
} from "./address.js";
import { isVendorBackendAsset } from "./vendor-backend.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import {
  type AssetDefinition,
  isPendingAnimaticShot,
  isPendingShot,
  type ReferenceDefinition,
  type AnimaticDefinition,
  type PanelDefinition,
  type PanelLane,
  type StageDefinition,
  type VideoDefinition,
} from "./types/index.js";

export interface DependencyGraph {
  dependencies: ReadonlyMap<string, readonly string[]>;
  dependents: ReadonlyMap<string, readonly string[]>;
  topologicalOrder: readonly string[];
  // Each asset built on a shot that is still a pendingShot, with the address it reaches for. No edge
  // hangs on it until the shot is developed.
  pendingReferences: readonly PendingReference[];
}

export type PendingReference = { from: string; ref: string };

function collectRefs(value: unknown, refs: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    const parsed = parsePlaceholder(value);
    if (parsed && parsed !== "seed") {
      refs.push(parsed);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectRefs(v, refs);
  }
}

export function extractRefs(entry: AssetDefinition): string[] {
  switch (entry.kind) {
    case "comfy": {
      const refs: string[] = [];
      collectRefs(entry.inputs, refs);
      return refs;
    }
    case "fal": {
      const refs: string[] = [];
      collectRefs(entry.inputs, refs);
      return refs;
    }
    case "local": {
      const refs: string[] = [];
      collectRefs(entry.inputs, refs);
      return refs;
    }
    case "file":
      return [];
  }
}

// A shot's keyframes in one lane: its own picture's, or the cutin's laid over it.
export function lanePanels(
  shot: AnimaticDefinition["shots"][number],
  lane: PanelLane,
): readonly PanelDefinition[] {
  return (lane === "main" ? shot.panels : shot.cutin?.panels) ?? [];
}

// Every keyframe a shot declares, both lanes.
function allPanels(shot: AnimaticDefinition["shots"][number]): PanelDefinition[] {
  return [...lanePanels(shot, "main"), ...lanePanels(shot, "cutin")];
}

export const LANES: readonly PanelLane[] = ["main", "cutin"];

// The plates a stage carries. Only the animatic declares any; typed here rather than at each call
// site so a `StageDefinition` reference stays legal.
export function platesOf(def: object | null | undefined): Record<string, AssetDefinition> {
  return (def as { plates?: Record<string, AssetDefinition> } | null)?.plates ?? {};
}

// The plates filed under a setup. A definition that never went through `defineAnimatic` filed all.
export function exposedPlateIdsOf(def: object | null | undefined): string[] {
  return (
    (def as { exposedPlateIds?: string[] } | null)?.exposedPlateIds ?? Object.keys(platesOf(def))
  );
}

export function buildDependencyGraph(
  video: StageDefinition | null,
  animatic?: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): DependencyGraph {
  // Each definition names its own stage, so a graph built over the animatic alone (its own
  // `generate`/`status` pass) addresses its nodes the same way a whole-project one does.
  const stages: Array<{ def: StageDefinition; stage: ShotStage }> = [
    ...(animatic && animatic !== video ? [{ def: animatic as StageDefinition }] : []),
    ...(video ? [{ def: video }] : []),
  ].map(({ def }) => ({ def, stage: def.stage }));

  const allAssetPaths = new Set<string>();
  for (const { def, stage } of stages) {
    for (const ap of listAssetPaths(def, stage)) allAssetPaths.add(ap);
  }

  // Reference assets are upstream roots that animatic/video consume; seed their paths so
  // a `reference:<name>` ref resolves to a real edge instead of failing as a missing path.
  if (reference) {
    for (const ap of listReferenceAssetPaths(reference)) {
      allAssetPaths.add(ap);
    }
  }

  // Shots that are still undeveloped (a pendingShot), as `<stage>:<id>`. An asset that references
  // one has nothing to build on yet: it is recorded, not refused, so the rest of the graph stands.
  const pending: PendingShots = { shots: new Set(), references: [] };
  for (const { def, stage } of stages) {
    for (const s of def.shots) {
      if (s.pending) pending.shots.add(`${stage}:${s.id}`);
    }
  }

  // Materialized-leaf nodes must be registered before the dependency maps and the topo sort are
  // built, or topologicalSort would treat them as missing and falsely report a cycle. Per stage:
  // one composition per developed shot, its stems (`listShotStems`), plus the timeline stem when the
  // stage has soundtrack beds.
  for (const { def, stage } of stages) {
    for (const s of def.shots) {
      if (s.shotFn) allAssetPaths.add(formatAssetPath(stage, s.id, COMPOSITION_ASSET_NAME));
      for (const stem of listShotStems(stage, s)) allAssetPaths.add(stem.address);
    }
    if ((def.timelineSoundtracks?.length ?? 0) > 0) {
      allAssetPaths.add(formatTimelineAssetPath(stage, STEM_ASSET_NAME));
    }
    if (def.overlay) allAssetPaths.add(formatTimelineAssetPath(stage, OVERLAY_ASSET_NAME));
  }

  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();

  for (const ap of allAssetPaths) {
    dependencies.set(ap, []);
    dependents.set(ap, []);
  }

  if (reference?.topLevelAssets) {
    for (const [assetName, entry] of Object.entries(reference.topLevelAssets)) {
      const assetPath = formatReferenceAssetPath(assetName);
      addDependencyEdges(assetPath, entry, allAssetPaths, dependencies, dependents);
    }
  }

  for (const { def, stage } of stages) {
    for (const [assetName, entry] of Object.entries(def.topLevelAssets ?? {})) {
      addDependencyEdges(
        formatTimelineAssetPath(stage, assetName),
        entry,
        allAssetPaths,
        dependencies,
        dependents,
        pending,
      );
    }

    for (const [setupId, entry] of Object.entries(platesOf(def))) {
      addDependencyEdges(
        formatPlateAssetPath(setupId),
        entry,
        allAssetPaths,
        dependencies,
        dependents,
        pending,
      );
    }

    for (const s of def.shots) {
      for (const [assetName, entry] of Object.entries(s.assets)) {
        addDependencyEdges(
          formatAssetPath(stage, s.id, assetName),
          entry,
          allAssetPaths,
          dependencies,
          dependents,
          pending,
        );
      }
    }

    // A DELIVERED composition depends on the picture assets its build references (audio sources go
    // to the shot's stem instead); an ANIMATIC composition depends on everything it consumes, audio
    // included — its sound and its timing are what the stage exists to settle. Either way a graph
    // leaf: nothing can reference a composition, so it only ever gains incoming deps.
    for (const s of def.shots) {
      if (!s.shotFn) continue;
      addEdges(
        formatAssetPath(stage, s.id, COMPOSITION_ASSET_NAME),
        stage === "animatic"
          ? (s.compositionRefs ?? [])
          : (s.pictureRefs ?? s.compositionRefs ?? []),
        allAssetPaths,
        dependencies,
        dependents,
        pending,
      );
    }

    // A stem depends on its audio sources — a per-shot stem on its cues, a timeline stem on the
    // soundtrack srcs. A video build consumes the board's stems (`animatic.shot(id).stem`,
    // `.narrationStem`), so those are leaves of their stage with dependents on the next.
    for (const s of def.shots) {
      for (const stem of listShotStems(stage, s)) {
        addEdges(stem.address, stem.refs, allAssetPaths, dependencies, dependents, pending);
      }
    }
    if ((def.timelineSoundtracks?.length ?? 0) > 0) {
      addEdges(
        formatTimelineAssetPath(stage, STEM_ASSET_NAME),
        (def.timelineSoundtracks ?? [])
          .map((st) => parsePlaceholder(st.src.src))
          .filter((p): p is string => p !== null),
        allAssetPaths,
        dependencies,
        dependents,
        pending,
      );
    }
    if (def.overlay) {
      addEdges(
        formatTimelineAssetPath(stage, OVERLAY_ASSET_NAME),
        def.overlay.compositionRefs,
        allAssetPaths,
        dependencies,
        dependents,
        pending,
      );
    }
  }

  validateReferencePurity(dependencies);
  assertUpstreamsPlaced(
    dependencies,
    video?.stage === "video" ? video : null,
    animatic ?? (video?.stage === "animatic" ? (video as AnimaticDefinition) : null),
    reference,
  );

  const topologicalOrder = topologicalSort(allAssetPaths, dependencies, dependents);

  return { dependencies, dependents, topologicalOrder, pendingReferences: pending.references };
}

// The reference stage is the shared upstream root: animatic/video may consume reference assets,
// but a reference asset may depend only on other reference assets. A reference reaching into a
// animatic/video asset would invert that layering — so reject it up front (in either direction).
function validateReferencePurity(dependencies: ReadonlyMap<string, readonly string[]>): void {
  for (const [assetPath, deps] of dependencies) {
    if (getStage(assetPath) !== "reference") continue;
    for (const dep of deps) {
      if (getStage(dep) !== "reference") {
        throw new KonteError(
          "INVALID_REFERENCE_DEPENDENCY",
          `Reference asset "${assetPath}" depends on "${dep}". References are an upstream root and ` +
            `may depend only on other reference assets — move "${dep}" into defineReference(), or ` +
            `consume "${assetPath}" from the animatic/video stage instead.`,
        );
      }
    }
  }
}

// Where each stage's output is looked at: a shot's composition, a shotFn-less shot's own assets, its
// stems, each non-pending animatic panel, the overlays, the soundtrack beds, and the pools a stage
// publishes (exposed reference assets, exposed plates).
function reviewRoots(
  video: StageDefinition | null,
  animatic: AnimaticDefinition | null,
  reference: ReferenceDefinition | null | undefined,
): string[] {
  const roots: string[] = [];

  // Exposed (returned) reference assets are usage roots: they are the pool published as
  // `reference.<name>`, generated even before a panel/composition consumes them. Anything they
  // transitively consume is reached from here; a declared-but-unexposed-and-unconsumed asset
  // stays unreachable and is reported as unused.
  if (reference) {
    for (const name of reference.exposedAssetNames ?? []) {
      roots.push(formatReferenceAssetPath(name));
    }
  }

  // A setup's plate is a usage root: it is the ground its panels are built on, so it is generated and
  // looked at BEFORE any of them exists — at which point every shot is still a `pendingShot`
  // declaring nothing, and reachability alone would call it unused. Same rule as an exposed
  // reference asset.
  for (const setupId of exposedPlateIdsOf(animatic)) {
    roots.push(formatPlateAssetPath(setupId));
  }

  // The animatic's own compositions are review roots of their own: each is what a human watches to
  // decide whether the shot may be spent on, so the takes it shows (a keyframe, a TTS line) are used
  // even before any video build consumes them. Its stems are konte's, not the author's, so they are
  // never "an asset nobody asked for" either.
  for (const def of [animatic, video]) {
    if (!def) continue;
    for (const s of def.shots) {
      if (s.shotFn) {
        roots.push(formatAssetPath(def.stage, s.id, COMPOSITION_ASSET_NAME));
      } else {
        for (const assetName of Object.keys(s.assets)) {
          roots.push(formatAssetPath(def.stage, s.id, assetName));
        }
      }
      for (const stem of listShotStems(def.stage, s)) roots.push(stem.address);
    }
    if ((def.timelineSoundtracks?.length ?? 0) > 0) {
      roots.push(formatTimelineAssetPath(def.stage, STEM_ASSET_NAME));
    }
    // The overlay is a leaf of its own: what it shows is used by it.
    if (def.overlay) roots.push(formatTimelineAssetPath(def.stage, OVERLAY_ASSET_NAME));
  }
  for (const s of animatic?.shots ?? []) {
    for (const panel of allPanels(s)) {
      // The panel's resolved path (shot-local / shared timeline / shared reference) is itself a
      // graph node key, so it is a render root directly — never reported unused.
      roots.push(panel.assetPath);
    }
  }

  // Timeline soundtracks are render roots too — a bed muxed onto the final video is
  // "used" even though no shot composition references it. Each entry's `src` is an
  // audio asset placeholder resolved to its asset path.
  for (const st of video ? mixedSoundtracks(video, video.timelineSoundtracks) : []) {
    const path = parsePlaceholder(st.src.src);
    if (path) roots.push(path);
  }
  return roots;
}

// `withinStage` stops at every stage boundary.
function reachFrom(
  dependencies: ReadonlyMap<string, readonly string[]>,
  roots: readonly string[],
  withinStage: boolean,
): Set<string> {
  const reached = new Set<string>();
  const stack = roots.filter((r) => dependencies.has(r));
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined || reached.has(p)) continue;
    reached.add(p);
    for (const dep of dependencies.get(p) ?? []) {
      if (!withinStage || getStage(dep) === getStage(p)) stack.push(dep);
    }
  }
  return reached;
}

// A take another stage consumes is one its own stage's review shows.
function assertUpstreamsPlaced(
  dependencies: ReadonlyMap<string, readonly string[]>,
  video: StageDefinition | null,
  animatic: AnimaticDefinition | null,
  reference: ReferenceDefinition | null | undefined,
): void {
  const shown = reachFrom(dependencies, reviewRoots(video, animatic, reference), true);
  const lines: string[] = [];
  for (const [consumer, deps] of dependencies) {
    for (const dep of deps) {
      if (getStage(dep) === getStage(consumer) || shown.has(dep)) continue;
      lines.push(`  ${dep} — consumed by ${consumer}`);
    }
  }
  if (lines.length === 0) return;
  throw new KonteError(
    "UPSTREAM_UNPLACED",
    `${lines.length} asset(s) consumed across stages are never shown on their own stage's review — ` +
      "place each in its shot's composition (on the board, a <Panel> or a layer), so the take " +
      "built on is one a human sees before accepting it",
    lines,
  );
}

// Asset paths no deliverable consumes — defined but unreachable from any render/review root, so
// they are not generated, not counted toward acceptance, and not needed for export.
export function listUnusedAssetPaths(
  video: VideoDefinition | null,
  animatic: AnimaticDefinition | null,
  graph: DependencyGraph,
  reference?: ReferenceDefinition | null,
): string[] {
  const needed = reachFrom(graph.dependencies, reviewRoots(video, animatic, reference), false);

  // Every reserved name is konte's own synthesis, never something an author declared, so an unused
  // one is not a wiring mistake to report.
  const synthesized = new Set([
    COMPOSITION_ASSET_NAME,
    STEM_ASSET_NAME,
    NARRATION_STEM_ASSET_NAME,
    SONG_STEM_ASSET_NAME,
  ]);
  const unused: string[] = [];
  for (const p of graph.dependencies.keys()) {
    if (needed.has(p) || synthesized.has(assetNameOf(parseAssetPath(p)))) continue;
    unused.push(p);
  }
  return unused;
}

// Every asset that transitively depends on `root` (its downstream cone), ordered so a
// dependency always precedes its dependents (the graph's topological order). `root` itself
// is excluded.
export function collectTransitiveDependents(graph: DependencyGraph, root: string): string[] {
  const reachable = new Set<string>();
  const stack = [...(graph.dependents.get(root) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined || reachable.has(p)) continue;
    reachable.add(p);
    for (const d of graph.dependents.get(p) ?? []) stack.push(d);
  }
  return graph.topologicalOrder.filter((p) => reachable.has(p));
}

/**
 * Whether every video take built on `assetPath` holds a human verdict, which a refresh of it leaves
 * standing — false when none is reached. The walk passes through other stages' takes, materialized
 * leaves and a take konte re-bakes over its accept; `verdictOf` is null for an asset no deliverable
 * consumes.
 */
export function videoDependentsHoldVerdicts(
  graph: DependencyGraph,
  assetPath: string,
  verdictOf: (assetPath: string) => "holds" | "rebakes" | "open" | null,
): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.dependents.get(assetPath) ?? [])];
  let held = false;
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined || seen.has(p)) continue;
    seen.add(p);
    if (getStage(p) === "video" && !isMaterializedLeafAssetPath(p)) {
      const verdict = verdictOf(p);
      if (verdict === "open") return false;
      if (verdict === "holds") held = true;
      if (verdict !== "rebakes") continue;
    }
    for (const d of graph.dependents.get(p) ?? []) stack.push(d);
  }
  return held;
}

/**
 * The dependents `konte reroll --with-dependents` rebuilds alongside `assetPath`, in dependency
 * order. Cross-stage dependents are excluded — a downstream stage is regenerated through its own
 * review cycle. The walk stops at a dependent holding a human verdict (`holdsVerdict`): that take and
 * whatever is reached only through it are left out.
 */
export function collectRerollCascade(
  graph: DependencyGraph,
  assetPath: string,
  definition: DefinitionLike,
  holdsVerdict: (assetPath: string) => boolean,
): Array<{ assetPath: string; def: AssetDefinition }> {
  const stage = getStage(assetPath);
  const reachable = new Set<string>();
  const stack = [...(graph.dependents.get(assetPath) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined || reachable.has(p) || holdsVerdict(p)) continue;
    reachable.add(p);
    for (const d of graph.dependents.get(p) ?? []) stack.push(d);
  }
  const cascade: Array<{ assetPath: string; def: AssetDefinition }> = [];
  for (const depPath of graph.topologicalOrder.filter((p) => reachable.has(p))) {
    if (getStage(depPath) !== stage || isMaterializedLeafAssetPath(depPath)) continue;
    const def = getAssetEntry(definition, depPath);
    if (def.kind === "file") continue;
    cascade.push({ assetPath: depPath, def });
  }
  return cascade;
}

// The nodes that ARE a shot's board: the keyframes its `<Panel>`s pin, the shot's declared assets,
// and its derived `#stem` and `#songStem`. A panel records where its keyframe really lives, which
// for a shared one is `animatic:timeline.<name>` or `reference:<name>` — outside this shot's
// address space.
function boardNodesOf(shot: AnimaticDefinition["shots"][number]): Set<string> {
  const nodes = new Set<string>(
    Object.keys(shot.assets).map((name) => formatAssetPath("animatic", shot.id, name)),
  );
  for (const panel of allPanels(shot)) nodes.add(panel.assetPath);
  if ((shot.stemRefs?.length ?? 0) > 0 || shot.songCue) {
    nodes.add(formatAssetPath("animatic", shot.id, STEM_ASSET_NAME));
  }
  if (shot.songCue && shot.songStem) {
    nodes.add(formatAssetPath("animatic", shot.id, SONG_STEM_ASSET_NAME));
  }
  return nodes;
}

export interface BoardlessVideoShot {
  shotId: string;
  // Whether the shot reaches a vendor backend (`isVendorBackendAsset`). Only these are refused: a
  // `file` or `local` asset takes a path or another take, never a board, so no edit would satisfy a
  // gate on one. `doctor` reports those instead.
  spends: boolean;
}

// Video shots that build on nothing from the board they develop. Walked per video shot from its
// deliverable's roots, so a board reached through a timeline asset counts and an asset the
// composition never draws counts for nothing. The board must be this shot's own — a `shot(…)` chain
// into another shot's keyframes is another shot's review. A `pendingShot` is listed by nobody.
export function listBoardlessVideoShots(
  video: VideoDefinition,
  animatic: AnimaticDefinition,
  graph: DependencyGraph,
): BoardlessVideoShot[] {
  const boardByShot = new Map<string, Set<string>>();
  for (const s of animatic.shots) {
    if (!isPendingAnimaticShot(s)) boardByShot.set(s.id, boardNodesOf(s));
  }

  // Timeline assets too: a shot's picture may come from one it closes over, which is in neither
  // `shot.assets` nor its own address space.
  const kindByAddress = new Map<string, AssetDefinition["kind"]>();
  for (const [name, entry] of Object.entries(video.topLevelAssets ?? {})) {
    kindByAddress.set(formatTimelineAssetPath("video", name), entry.kind);
  }
  for (const s of video.shots) {
    for (const [name, entry] of Object.entries(s.assets)) {
      kindByAddress.set(formatAssetPath("video", s.id, name), entry.kind);
    }
  }

  const boardless: BoardlessVideoShot[] = [];
  for (const s of video.shots) {
    if (isPendingShot(s)) continue;
    // An aside develops no board shot, so neither the gate nor the doctor warning has anything to
    // say about it.
    if (s.aside === true) continue;
    const board = boardByShot.get(s.id) ?? new Set<string>();

    // The roots `listUnusedAssetPaths` uses. A fallback shot has no composition to reach them
    // through, so there its assets are the roots.
    const stack: string[] = [];
    if (s.shotFn) {
      stack.push(formatAssetPath("video", s.id, COMPOSITION_ASSET_NAME));
      for (const stem of listShotStems("video", s)) stack.push(stem.address);
    } else {
      stack.push(...Object.keys(s.assets).map((name) => formatAssetPath("video", s.id, name)));
    }

    const seen = new Set<string>();
    let consumesBoard = false;
    let spends = false;
    // A reference to its own board shot, still a pendingShot, is a board it builds on that has no take
    // yet — `pending-reference` holds what is built on it.
    const ownBoard = new RegExp(`^animatic:shot\\.${s.id}[.#]`);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      // Every video shot over a narrated shot places its `#narrationStem`, whatever it builds its
      // picture on — so that builds nothing on the board.
      if (isNarrationStemAddress(node)) continue;
      if (
        board.has(node) ||
        graph.pendingReferences.some(
          (r) => r.from === node && ownBoard.test(r.ref) && !isNarrationStemAddress(r.ref),
        )
      ) {
        consumesBoard = true;
        break;
      }
      if (isVendorBackendAsset(kindByAddress.get(node) ?? "file")) spends = true;
      stack.push(...(graph.dependencies.get(node) ?? []));
    }
    // A graphic shot that spends nothing owes the board nothing; one that spends is refused like any
    // other.
    if (!consumesBoard && (spends || s.graphic !== true)) boardless.push({ shotId: s.id, spends });
  }
  return boardless;
}

type PendingShots = { shots: Set<string>; references: PendingReference[] };

function addDependencyEdges(
  assetPath: string,
  entry: AssetDefinition,
  allAssetPaths: Set<string>,
  dependencies: Map<string, string[]>,
  dependents: Map<string, string[]>,
  pending?: PendingShots,
): void {
  addEdges(assetPath, extractRefs(entry), allAssetPaths, dependencies, dependents, pending);
}

const SHOT_REF = /^(animatic|video):shot\.([^.#]+)[.#]/;

function addEdges(
  assetPath: string,
  refs: readonly string[],
  allAssetPaths: Set<string>,
  dependencies: Map<string, string[]>,
  dependents: Map<string, string[]>,
  pending?: PendingShots,
): void {
  for (const refPath of new Set(refs)) {
    if (!allAssetPaths.has(refPath)) {
      const shot = SHOT_REF.exec(refPath);
      if (pending && shot && pending.shots.has(`${shot[1]}:${shot[2]}`)) {
        pending.references.push({ from: assetPath, ref: refPath });
        continue;
      }
      throw new KonteError(
        "INVALID_REFERENCE",
        `Asset "${assetPath}" references non-existent path "${refPath}"`,
      );
    }
    dependencies.get(assetPath)?.push(refPath);
    dependents.get(refPath)?.push(assetPath);
  }
}

// Binary min-heap over strings: always yields the lexicographically smallest entry, which is
// what keeps the topological order deterministic. Replaces a sorted-array queue whose
// insert/shift were O(V) each — O(V²) across a sort of thousands of nodes.
class StringMinHeap {
  private readonly heap: string[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(value: string): void {
    const heap = this.heap;
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]! <= heap[i]!) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  }

  pop(): string | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left]! < heap[smallest]!) smallest = left;
        if (right < heap.length && heap[right]! < heap[smallest]!) smallest = right;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

function topologicalSort(
  nodes: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, string[]>,
  dependents: ReadonlyMap<string, string[]>,
): string[] {
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node, dependencies.get(node)?.length ?? 0);
  }

  const queue = new StringMinHeap();
  for (const [node, deg] of inDegree) {
    if (deg === 0) {
      queue.push(node);
    }
  }

  const result: string[] = [];
  for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
    result.push(node);

    // Only nodes that actually depend on `node` can be unblocked by it, so walk the
    // precomputed `dependents` adjacency instead of rescanning every edge (O(V+E)).
    for (const other of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(other) ?? 0) - 1;
      inDegree.set(other, newDeg);
      if (newDeg === 0) {
        queue.push(other);
      }
    }
  }

  if (result.length !== nodes.size) {
    const resolved = new Set(result);
    const remaining = [...nodes].filter((n) => !resolved.has(n));
    throw new KonteError(
      "CYCLE_DETECTED",
      `Dependency cycle detected involving: ${remaining.join(", ")}`,
    );
  }

  return result;
}
