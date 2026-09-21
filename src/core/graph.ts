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
  parseAssetPath,
  tryParseAddress,
  STEM_ASSET_NAME,
  assetNameOf,
  type DefinitionLike,
  getAssetEntry,
  isMaterializedLeafAssetPath,
  isNarrationStemAddress,
} from "./address.js";
import { isVendorBackendAsset } from "./backend-policy.js";
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

// The plates a stage carries. Only the animatic declares any; typed here rather than at each call
// site so a `StageDefinition` reference stays legal.
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

/**
 * One camera frame the direction places on a board shot: which lane of which shot, on which setup.
 */
export type BoardFrame = { shotId: string; lane: PanelLane; setup: string };

function platesOf(def: object | null | undefined): Record<string, AssetDefinition> {
  return (def as { plates?: Record<string, AssetDefinition> } | null)?.plates ?? {};
}

// The plates filed under a setup. A definition that never went through `defineAnimatic` filed all.
function exposedPlateIdsOf(def: object | null | undefined): string[] {
  return (
    (def as { exposedPlateIds?: string[] } | null)?.exposedPlateIds ?? Object.keys(platesOf(def))
  );
}

export function buildDependencyGraph(
  video: StageDefinition,
  animatic?: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): DependencyGraph {
  // Each definition names its own stage, so a graph built over the animatic alone (its own
  // `generate`/`status` pass) addresses its nodes the same way a whole-project one does.
  const stages: Array<{ def: StageDefinition; stage: ShotStage }> = [
    ...(animatic && animatic !== video ? [{ def: animatic as StageDefinition }] : []),
    { def: video },
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

    for (const [setupId, entry] of Object.entries(platesOf(def))) {
      addDependencyEdges(
        formatPlateAssetPath(setupId),
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
  video: VideoDefinition,
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

  // A setup's plate is a usage root: it is the ground its panels are built on, so it is generated and
  // looked at BEFORE any of them exists — at which point every shot is still a `pendingShot`
  // declaring nothing, and reachability alone would call it unused. Same rule as an exposed
  // reference asset.
  for (const setupId of exposedPlateIdsOf(animatic)) {
    roots.push(formatPlateAssetPath(setupId));
  }

  for (const s of video.shots) {
    if (s.shotFn) {
      roots.push(formatAssetPath("video", s.id, COMPOSITION_ASSET_NAME));
    } else {
      for (const assetName of Object.keys(s.assets)) {
        roots.push(formatAssetPath("video", s.id, assetName));
      }
    }
    for (const stem of listShotStems("video", s)) roots.push(stem.address);
  }
  if ((video.timelineSoundtracks?.length ?? 0) > 0) {
    roots.push(formatTimelineAssetPath("video", STEM_ASSET_NAME));
  }

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
  for (const st of video.timelineSoundtracks ?? []) {
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
  const synthesized = new Set([COMPOSITION_ASSET_NAME, STEM_ASSET_NAME, NARRATION_STEM_ASSET_NAME]);
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
// and its derived `#stem`. A panel records where its keyframe really lives, which for a shared one is
// `animatic:timeline.<name>` or `reference:<name>` — outside this shot's address space.
function boardNodesOf(shot: AnimaticDefinition["shots"][number]): Set<string> {
  const nodes = new Set<string>(
    Object.keys(shot.assets).map((name) => formatAssetPath("animatic", shot.id, name)),
  );
  for (const panel of allPanels(shot)) nodes.add(panel.assetPath);
  if ((shot.stemRefs?.length ?? 0) > 0) {
    nodes.add(formatAssetPath("animatic", shot.id, STEM_ASSET_NAME));
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
export type SetupAnchorGaps = {
  // Setup ids whose plate stands on no location reference — bar one built from no reference at all.
  unanchoredPlates: string[];
  // Shot ids that reach neither anchor, keyed by the setup they sit on.
  unanchoredShots: Map<string, string[]>;
  // Developed frames with no generative step, keyed by setup, so the plate demand can drop them too.
  // A `pendingShot` is not among them: it declares nothing yet, so it still counts toward a plate.
  deterministicShots: Map<string, number>;
};

export function listSetupAnchorGaps(
  animatic: AnimaticDefinition,
  frames: readonly BoardFrame[],
  locationBySetup: ReadonlyMap<string, string>,
): SetupAnchorGaps {
  const plates = platesOf(animatic);
  const entryOf = animaticEntryResolver(animatic);

  const unanchoredPlates: string[] = [];
  for (const setupId of Object.keys(plates)) {
    // An unknown setup id is the direction's own finding (`unused-setup` / a plate keyed off-roster);
    // reporting it again as unanchored would name the wrong fix.
    const location = locationBySetup.get(setupId);
    if (location === undefined) continue;
    const walk = walkPictureChain(
      [formatPlateAssetPath(setupId)],
      formatReferenceAssetPath(location),
      entryOf,
    );
    if ((walk.generative || walk.touchedReference) && !walk.reached) unanchoredPlates.push(setupId);
  }

  const unanchoredShots = new Map<string, string[]>();
  const deterministicShots = new Map<string, number>();
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
        ? formatPlateAssetPath(setupId)
        : location !== undefined
          ? formatReferenceAssetPath(location)
          : undefined;
    if (target === undefined) continue;

    // Rooted at the PANELS alone — the keyframes are what these findings are about. Not the shot's
    // declared pool, and not `compositionRefs` either, which carries every layer the shot renders:
    // an overlay or a sound that happens to take the anchor says nothing about the frame the keyframe
    // was drawn on. Everything legitimately reachable — a shot asset the panel consumes, a timeline
    // asset, a `shot(…)` chain — is reached from a panel.
    const walk = walkPictureChain(
      lanePanels(shot, frame.lane).map((panel) => panel.assetPath),
      target,
      entryOf,
    );
    if (!walk.generative) {
      deterministicShots.set(setupId, (deterministicShots.get(setupId) ?? 0) + 1);
      continue;
    }
    if (walk.reached) continue;
    const shots = unanchoredShots.get(setupId) ?? [];
    if (!shots.includes(shot.id)) shots.push(shot.id);
    unanchoredShots.set(setupId, shots);
  }

  return { unanchoredPlates, unanchoredShots, deterministicShots };
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
    const parentAddress = formatPlateAssetPath(parentId);
    const chain = chainAddresses([formatPlateAssetPath(id)], entryOf);
    if ([...chain].some((address) => cutFrom.get(address)?.has(parentAddress))) continue;
    const crops = cropsInChain(formatPlateAssetPath(id), entryOf);
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

/**
 * How one developed shot on a plated setup carries its plate in TEXT — the half `setup-unconsumed`
 * cannot see.
 */
export type PlateDescriptionUse = {
  setupId: string;
  shotId: string;
  lane: PanelLane;
  // A panel that was handed the plate carries the plate's own sentence verbatim.
  describes: boolean;
};

// The sentence is read off every step BETWEEN a panel and the plate — the panel itself, and the
// intermediates it is derived from that still stand on the plate. A wrapper panel carries no text of
// its own, so reading the panel address alone would exempt a shot whose real keyframe took the plate
// and dropped the sentence. A step off that path is not read: the plate's own generation prompt and
// its upstream reach the plate from nowhere, and a sibling branch conditions a picture the plate
// never entered.
//
// Exempt on the same two conditions as `setup-unconsumed`: a shot with nothing generative in its
// chain has no prompt to write the sentence in, and one that never reaches the plate is that
// finding's to report, not this one's. One more is this finding's own — a shot whose path to the
// plate conditions on no text at all has no body the sentence could go in.
export function listPlateDescriptionUses(
  animatic: AnimaticDefinition,
  frames: readonly BoardFrame[],
): PlateDescriptionUse[] {
  const platePrompts = animatic.platePrompts ?? {};
  if (Object.keys(platePrompts).length === 0) return [];
  const entryOf = animaticEntryResolver(animatic);
  const shotById = new Map(animatic.shots.map((shot) => [shot.id, shot]));
  const out: PlateDescriptionUse[] = [];
  for (const frame of frames) {
    const shot = shotById.get(frame.shotId);
    if (shot === undefined || isPendingAnimaticShot(shot)) continue;
    const setupId = frame.setup;
    const platePrompt = platePrompts[setupId];
    if (platePrompt === undefined) continue;
    const panels = lanePanels(shot, frame.lane).map((panel) => panel.assetPath);
    const plate = formatPlateAssetPath(setupId);
    if (!walkPictureChain(panels, plate, entryOf).generative) continue;

    const standsOnPlate = (address: string) => chainAddresses([address], entryOf).has(plate);
    const prompts: string[] = [];
    let plated = false;
    for (const panel of panels) {
      const chain = chainAddresses([panel], entryOf);
      if (!chain.has(plate)) continue;
      plated = true;
      for (const address of chain) {
        if (address === plate || !standsOnPlate(address)) continue;
        prompts.push(...positivePromptsAt(animatic, address));
      }
    }
    if (!plated || prompts.length === 0) continue;
    out.push({
      setupId,
      shotId: shot.id,
      lane: frame.lane,
      describes: prompts.some((text) => text.includes(platePrompt)),
    });
  }
  return out;
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
};

// Structural so a listing can pass the definition it already loaded.
export type PanelConditioningSource = AnimaticPictureSource & {
  prompts?: readonly { address: string; negative?: boolean; spoken?: boolean }[];
};

// A panel name is the author's and a wrapper carries no text of its own, so which prompt writes a
// shot's opening frame is not readable off the addresses. The chain crosses shots, the timeline and
// the plates; an address outside this stage declares no prompt here, so it drops out.
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
          panel: panel.assetPath,
          conditioning: orderedChainAddresses([panel.assetPath], entryOf).filter((address) =>
            written.has(address),
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
 * How each developed board shot meets the shot before it: the two keyframes that answer for a seam,
 * and what the opening one was handed of the frame it cuts from.
 */
export type ShotContinuity = {
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
      const panels = lanePanels(shot, lane).map((panel) => panel.assetPath);
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
// passed as is — what `promptReferenceTags`' `prevPanel` check sees. A wrapped panel is an ordinary
// input.
function prevPanelSources(animatic: AnimaticDefinition): Map<string, Set<string>> {
  const readers = new Set(animatic.prevPanelReaders ?? []);
  const out = new Map<string, Set<string>>();
  for (const input of animatic.imageInputs ?? []) {
    if (!readers.has(input.address)) continue;
    const reader = tryParseAddress(input.address);
    const shotId = reader?.stage === "animatic" && reader.kind === "shot" ? reader.shotId : null;
    for (const source of input.sources) {
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
        // A keyframe may be a shot asset, a timeline asset or a plate — all three are one call whose
        // input order decides where a subject lands.
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
          panel: panel.assetPath,
          ...walkReferenceReach(panel.assetPath, entryOf),
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
function walkPictureChain(
  roots: readonly string[],
  target: string,
  entryOf: (address: string) => AssetDefinition | undefined,
): { reached: boolean; generative: boolean; touchedReference: boolean } {
  const seen = new Set<string>();
  const stack = [...roots];
  let reached = false;
  let generative = false;
  let touchedReference = false;
  while (stack.length > 0) {
    const address = stack.pop()!;
    if (address === target) reached = true;
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
  return { reached, generative, touchedReference };
}
