import { mixedSoundtracks } from "./song-bed.js";
import {
  type ShotStage,
  COMPOSITION_ASSET_NAME,
  formatAssetPath,
  formatReferenceAssetPath,
  formatDraftAssetPath,
  formatTimelineAssetPath,
  getStage,
  listAssetPaths,
  listReferenceAssetPaths,
  listShotStems,
  NARRATION_STEM_ASSET_NAME,
  SONG_STEM_ASSET_NAME,
  parseAssetPath,
  tryParseAddress,
  OVERLAY_ASSET_NAME,
  STEM_ASSET_NAME,
  assetNameOf,
  type DefinitionLike,
  getAssetEntry,
  isMaterializedLeafAssetPath,
  isDraftAddress,
  isDraftTakeAddress,
  isNarrationStemAddress,
} from "./address.js";
import { isVendorBackendAsset } from "./vendor-backend.js";
import type { PinWindow, VideoShotPins } from "./direction-check.js";
import type { PinOccurrence } from "./pin-check.js";
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
  type ShotDefinition,
  type StageDefinition,
  type VideoDefinition,
} from "./types/index.js";

export interface DependencyGraph {
  dependencies: ReadonlyMap<string, readonly string[]>;
  dependents: ReadonlyMap<string, readonly string[]>;
  topologicalOrder: readonly string[];
}

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

const LANES: readonly PanelLane[] = ["main", "cutin"];

function draftsOf(def: object | null | undefined): Record<string, AssetDefinition> {
  return (def as { drafts?: Record<string, AssetDefinition> } | null)?.drafts ?? {};
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

  // Animatic shots that are still undeveloped (a pendingShot). An asset that references one of
  // these has nothing to build on, so we surface a targeted error rather than the generic
  // "non-existent path". Threaded into every edge pass that can reach an animatic shot path.
  const pendingAnimaticShots = new Set<string>();
  if (animatic) {
    for (const s of animatic.shots) {
      if (isPendingAnimaticShot(s)) pendingAnimaticShots.add(s.id);
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
        pendingAnimaticShots,
      );
    }

    for (const [name, entry] of Object.entries(draftsOf(def))) {
      addDependencyEdges(
        formatDraftAssetPath(name),
        entry,
        allAssetPaths,
        dependencies,
        dependents,
        pendingAnimaticShots,
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
          pendingAnimaticShots,
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
        pendingAnimaticShots,
      );
    }

    // A stem depends on its audio sources — a per-shot stem on its cues, a timeline stem on the
    // soundtrack srcs. A video build consumes the board's stems (`animatic.shot(id).stem`,
    // `.narrationStem`), so those are leaves of their stage with dependents on the next.
    for (const s of def.shots) {
      for (const stem of listShotStems(stage, s)) {
        addEdges(
          stem.address,
          stem.refs,
          allAssetPaths,
          dependencies,
          dependents,
          pendingAnimaticShots,
        );
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
        pendingAnimaticShots,
      );
    }
    if (def.overlay) {
      addEdges(
        formatTimelineAssetPath(stage, OVERLAY_ASSET_NAME),
        def.overlay.compositionRefs,
        allAssetPaths,
        dependencies,
        dependents,
        pendingAnimaticShots,
      );
    }
  }

  validateReferencePurity(dependencies);

  const topologicalOrder = topologicalSort(allAssetPaths, dependencies, dependents);

  return { dependencies, dependents, topologicalOrder };
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

// Asset paths no deliverable consumes — defined but unreachable from any render/review
// root, so they are not generated, not counted toward acceptance, and not needed for
// export. Roots are where output is actually produced: a video shot's composition (it
// pulls in `compositionRefs`), a shotFn-less shot's own assets (the render falls back to
// whichever resolves), and each non-pending animatic panel. "Used" is the forward
// closure of `dependencies` from those roots, so a timeline OR shot-level asset that the
// composition (and everything reachable) never touches is reported here. Composition
// nodes are synthesized, not user assets, so they are never reported.
export function listUnusedAssetPaths(
  video: VideoDefinition | null,
  animatic: AnimaticDefinition | null,
  graph: DependencyGraph,
  reference?: ReferenceDefinition | null,
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

  // A draft take is a usage root: the panels are written from its frames, so it is generated while
  // its shots are still `pendingShot`s.
  for (const name of Object.keys((animatic as { draftShots?: object } | null)?.draftShots ?? {})) {
    roots.push(formatDraftAssetPath(name));
  }

  for (const s of video?.shots ?? []) {
    if (s.shotFn) {
      roots.push(formatAssetPath("video", s.id, COMPOSITION_ASSET_NAME));
    } else {
      for (const assetName of Object.keys(s.assets)) {
        roots.push(formatAssetPath("video", s.id, assetName));
      }
    }
    for (const stem of listShotStems("video", s)) roots.push(stem.address);
  }
  if ((video?.timelineSoundtracks?.length ?? 0) > 0) {
    roots.push(formatTimelineAssetPath("video", STEM_ASSET_NAME));
  }
  // The overlay is a leaf of its own: what it shows is used by it.
  if (video?.overlay) roots.push(formatTimelineAssetPath("video", OVERLAY_ASSET_NAME));
  if (animatic?.overlay) roots.push(formatTimelineAssetPath("animatic", OVERLAY_ASSET_NAME));

  // The animatic's own compositions are review roots of their own: each is what a human watches to
  // decide whether the shot may be spent on, so the takes it shows (a keyframe, a TTS line) are used
  // even before any video build consumes them. Its stems are konte's, not the author's, so they are
  // never "an asset nobody asked for" either.
  for (const s of animatic?.shots ?? []) {
    if (s.shotFn) roots.push(formatAssetPath("animatic", s.id, COMPOSITION_ASSET_NAME));
    for (const stem of listShotStems("animatic", s)) roots.push(stem.address);
    for (const panel of allPanels(s)) {
      // The panel's resolved path (shot-local / shared timeline / shared reference) is itself a
      // graph node key, so it is a render root directly — never reported unused.
      roots.push(panel.assetPath);
    }
  }
  if ((animatic?.timelineSoundtracks?.length ?? 0) > 0) {
    roots.push(formatTimelineAssetPath("animatic", STEM_ASSET_NAME));
  }

  // Timeline soundtracks are render roots too — a bed muxed onto the final video is
  // "used" even though no shot composition references it. Each entry's `src` is an
  // audio asset placeholder resolved to its asset path.
  for (const st of video ? mixedSoundtracks(video, video.timelineSoundtracks) : []) {
    const path = parsePlaceholder(st.src.src);
    if (path) roots.push(path);
  }

  const needed = new Set<string>();
  const stack = roots.filter((r) => graph.dependencies.has(r));
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined || needed.has(p)) continue;
    needed.add(p);
    for (const dep of graph.dependencies.get(p) ?? []) stack.push(dep);
  }

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
 * whatever is reached only through it are left out. A draft cascades into nothing: the frames cut
 * from it move only with their own `at`.
 */
export function collectRerollCascade(
  graph: DependencyGraph,
  assetPath: string,
  definition: DefinitionLike,
  holdsVerdict: (assetPath: string) => boolean,
): Array<{ assetPath: string; def: AssetDefinition }> {
  if (isDraftAddress(assetPath)) return [];
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
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      // Every video shot over a narrated shot places its `#narrationStem`, whatever it builds its
      // picture on — so that builds nothing on the board.
      if (isNarrationStemAddress(node)) continue;
      if (board.has(node)) {
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

function addDependencyEdges(
  assetPath: string,
  entry: AssetDefinition,
  allAssetPaths: Set<string>,
  dependencies: Map<string, string[]>,
  dependents: Map<string, string[]>,
  pendingAnimaticShots?: ReadonlySet<string>,
): void {
  addEdges(
    assetPath,
    extractRefs(entry),
    allAssetPaths,
    dependencies,
    dependents,
    pendingAnimaticShots,
  );
}

const ANIMATIC_SHOT_REF = /^animatic:shot\.([^.]+)\./;

function addEdges(
  assetPath: string,
  refs: readonly string[],
  allAssetPaths: Set<string>,
  dependencies: Map<string, string[]>,
  dependents: Map<string, string[]>,
  pendingAnimaticShots?: ReadonlySet<string>,
): void {
  for (const refPath of new Set(refs)) {
    if (!allAssetPaths.has(refPath)) {
      const pendingMatch = pendingAnimaticShots && ANIMATIC_SHOT_REF.exec(refPath);
      if (pendingMatch && pendingAnimaticShots.has(pendingMatch[1]!)) {
        throw new KonteError(
          "INVALID_REFERENCE",
          `Asset "${assetPath}" references "${refPath}", but animatic shot "${pendingMatch[1]}" is still a pendingShot (undeveloped). ` +
            `Develop that animatic shot first (swap pendingShot for shot via layout-guide) before depending on it.`,
        );
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

/**
 * One `imageCrop`: the address it cuts and the window it takes, in that source's own pixels.
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

/**
 * The conditioning text one keyframe stands on — the panel's own positive prompts and those of every
 * step behind it. Panels come out in panel order.
 */
export type PanelPromptText = {
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
        for (const address of chainAddresses([panel.assetPath], entryOf)) {
          texts.push(...positivePromptsAt(animatic, address));
        }
        out.push({
          shotId: shot.id,
          lane,
          panel: panel.assetPath,
          texts,
          generative: walkReferenceReach(panel.assetPath, entryOf).generative,
        });
      }
    }
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
  // The draft frames of this shot the panel is drawn from: which take, and the second it is cut at.
  draftFrames?: { address: string; draft: string; at: number }[];
};

// Structural so a listing can pass the definition it already loaded.
export type PanelConditioningSource = AnimaticPictureSource & {
  prompts?: readonly { address: string; negative?: boolean; spoken?: boolean }[];
};

// A panel name is the author's and a wrapper carries no text of its own, so which prompt writes a
// shot's opening frame is not readable off the addresses. The chain crosses shots and the
// timeline; an address outside this stage declares no prompt here, so it drops out.
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
        const chain = orderedChainAddresses([panel.assetPath], entryOf);
        const draftFrames = chain.flatMap((address) => {
          const parsed = tryParseAddress(address);
          if (parsed?.kind !== "shot" || parsed.shotId !== shot.id) return [];
          const frame = draftFrameOf(entryOf(address));
          return frame ? [{ address, ...frame }] : [];
        });
        out.push({
          shotId: shot.id,
          lane,
          index: i + 1,
          of: panels.length,
          panel: panel.assetPath,
          conditioning: chain.filter((address) => written.has(address)),
          ...(draftFrames.length > 0 ? { draftFrames } : {}),
        });
      });
    }
  }
  return out;
}

// A `videoFrame` cut out of a draft take: the take's name and the second it is cut at.
function draftFrameOf(entry: AssetDefinition | undefined): { draft: string; at: number } | null {
  if (entry?.kind !== "local" || entry.operation !== "frame") return null;
  const { source, at } = entry.inputs as { source?: unknown; at?: unknown };
  const address = typeof source === "string" ? parsePlaceholder(source) : null;
  if (!address || !isDraftTakeAddress(address) || typeof at !== "number") return null;
  return { draft: tryParseAddress(address)!.assetName, at };
}

// Every address one picture's chain reaches, the root itself included.
function chainAddresses(
  roots: readonly string[],
  entryOf: (address: string) => AssetDefinition | undefined,
): Set<string> {
  return new Set(orderedChainAddresses(roots, entryOf));
}

// The same walk, kept in declaration order: the root, then each input as the definition passes it.
function orderedChainAddresses(
  roots: readonly string[],
  entryOf: (address: string) => AssetDefinition | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (address: string): void => {
    if (seen.has(address)) return;
    seen.add(address);
    out.push(address);
    const entry = entryOf(address);
    if (entry) for (const ref of extractRefs(entry)) visit(ref);
  };
  for (const root of roots) visit(root);
  return out;
}

// The conditioning text one panel carries. The negative half excludes rather than defines, and a
// spoken line is words said inside the frame, so neither describes it.
function positivePromptsAt(animatic: AnimaticDefinition, address: string): string[] {
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
      ...(shot.panels ?? []).map((p) => p.assetPath),
    ]),
    cutin: walk([...cutinRefs, ...(shot.cutin?.panels ?? []).map((p) => p.assetPath)]),
  };
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
        reaches,
        ...(window ? { window } : {}),
      });
    }
  }
  return [...byFrame.values()];
}

export type PictureCueLike = {
  src: string;
  start: number | null;
  duration: number | null;
  mediaStart: number | null;
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
      // The shot cuts at its end whatever the cue declares, and the take runs out at its own.
      let played = Math.min(c.duration ?? shotSec - opensAt, shotSec - opensAt);
      if (clipSec !== undefined) played = Math.min(played, clipSec - from);
      return { opensAt, closesAt: opensAt + played, from, to: from + played };
    });
  if (windows.length === 0) return undefined;
  const pick =
    pin.pin === "start"
      ? windows.reduce((a, b) => (b.opensAt < a.opensAt ? b : a))
      : windows.reduce((a, b) => (b.closesAt > a.closesAt ? b : a));
  return {
    take: pin.address,
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
 * The two keyframes each developed board shot answers a seam with.
 */
export type ShotContinuity = {
  shotId: string;
  lane: PanelLane;
  // The keyframe answering for the cut INTO this shot, and the one the next shot cuts from — the
  // same first/last split `lineup` and `lineupTo` are read at.
  firstPanel: string;
  lastPanel: string;
};

// A shot with no panels — a pending one, a board aside — answers nothing and is left out; so does a
// lane with none, which is a graphic shot's main frame. Each lane is its own camera and answers its
// own seam.
export function listShotContinuity(animatic: AnimaticDefinition): ShotContinuity[] {
  const out: ShotContinuity[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      const panels = lanePanels(shot, lane).map((panel) => panel.assetPath);
      const firstPanel = panels[0];
      const lastPanel = panels[panels.length - 1];
      if (firstPanel === undefined || lastPanel === undefined) continue;
      out.push({ shotId: shot.id, lane, firstPanel, lastPanel });
    }
  }
  return out;
}

/** One keyframe's `reference:<id>` slots, in the order that panel's own inputs declare them. */
export type PanelReferenceSlots = {
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
        // A keyframe may be a shot asset or a timeline asset — either is one call whose input order
        // decides where a subject lands.
        const entry = entryOf(panel.assetPath);
        if (!entry) continue;
        const slots: string[] = [];
        for (const ref of extractRefs(entry)) {
          const target = tryParseAddress(ref);
          if (!target || target.stage !== "reference" || target.kind !== "reference") continue;
          if (slots.includes(target.assetName)) continue;
          slots.push(target.assetName);
        }
        if (slots.length > 0) out.push({ shotId: shot.id, lane, panel: panel.assetPath, slots });
      }
    }
  }
  return out;
}

/**
 * One keyframe's reference REACH — every `reference:<id>` the chain behind that panel stands on.
 * Panels come out in panel order.
 */
export type PanelReferenceReach = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  // A SET in list form, in no meaningful order — the order that decides where a subject lands is
  // `listPanelReferenceSlots`'.
  refs: string[];
  // False when nothing in the chain generates — a `file` keyframe, a trim of one.
  generative: boolean;
};

// The references each developed animatic shot's keyframes stand on — what `character-unconsumed` and
// `location-unconsumed` read. Unlike `listPanelReferenceSlots`, this walks the CHAIN behind each
// panel rather than its own inputs: a keyframe drawn from an earlier keyframe carries that frame's
// subjects in the picture.
export function listPanelReferenceReach(
  animatic: AnimaticDefinition,
  reference?: ReferenceDefinition | null,
): PanelReferenceReach[] {
  const entryOf = animaticEntryResolver(animatic);
  const out: PanelReferenceReach[] = [];
  for (const shot of animatic.shots) {
    if (isPendingAnimaticShot(shot)) continue;
    for (const lane of LANES) {
      for (const panel of lanePanels(shot, lane)) {
        out.push({
          shotId: shot.id,
          lane,
          panel: panel.assetPath,
          ...walkReferenceReach(panel.assetPath, entryOf, reference),
        });
      }
    }
  }
  return out;
}

// A `reference:<id>` is recorded and, where the reference stage is at hand, walked on through what
// it was built from — a frame cut out of a location sheet stands on that location. Whether the chain
// generates is the animatic's own question, so a reference asset never answers it.
function walkReferenceReach(
  root: string,
  entryOf: (address: string) => AssetDefinition | undefined,
  reference?: ReferenceDefinition | null,
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
      const built = reference?.topLevelAssets?.[parsed.assetName];
      if (built) stack.push(...extractRefs(built));
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
export type AnimaticPictureSource = {
  shots: readonly {
    id: string;
    assets: Record<string, AssetDefinition>;
    pending?: boolean;
    panels?: readonly PanelDefinition[];
    cutin?: { panels?: readonly PanelDefinition[] } | null;
  }[];
  topLevelAssets?: Record<string, AssetDefinition>;
};

// One address → its declaration, over the animatic's drafts, timeline and shots. A panel drawn
// from a draft's frame reaches the references that draft was handed.
function animaticEntryResolver(
  animatic: AnimaticPictureSource,
): (address: string) => AssetDefinition | undefined {
  const drafts = draftsOf(animatic);
  return (address) => {
    const parsed = tryParseAddress(address);
    if (!parsed || parsed.stage !== "animatic") return undefined;
    if (parsed.kind === "draft") return drafts[parsed.assetName];
    if (parsed.kind === "timeline") return animatic.topLevelAssets?.[parsed.assetName];
    if (parsed.kind === "shot") {
      return animatic.shots.find((s) => s.id === parsed.shotId)?.assets[parsed.assetName];
    }
    return undefined;
  };
}
