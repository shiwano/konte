import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DefinitionLike } from "../../../../core/address.js";
import type { DependencyGraph } from "../../../../core/graph.js";
import { StateManager } from "../../../../core/state/index.js";
import { buildKeepGraph } from "../keep-graph.js";

const SHEET = "reference:sheet";
const PLATE = "animatic:plate.front";
const BG = "animatic:timeline.bg";
const SMALL = "animatic:timeline.small";

const generated = { kind: "comfy", workflow: "image.json", inputs: {} };
const deterministic = { kind: "local", op: "imageResize", inputs: {}, deterministic: true };

// A reference sheet the board's plate and a timeline background are made from, and a resize konte
// bakes from the background.
const reference = {
  topLevelAssets: { sheet: generated },
  exposedAssetNames: ["sheet"],
} as unknown as DefinitionLike;
const animatic = {
  stage: "animatic",
  shots: [],
  topLevelAssets: { bg: generated, small: deterministic },
  plates: { front: generated },
} as unknown as DefinitionLike;

function graphOf(edges: Array<[string, string]>): DependencyGraph {
  const nodes = [...new Set(edges.flat())];
  const dependencies = new Map(
    nodes.map((n) => [n, edges.filter(([, to]) => to === n).map(([from]) => from)]),
  );
  const dependents = new Map(
    nodes.map((n) => [n, edges.filter(([from]) => from === n).map(([, to]) => to)]),
  );
  return { dependencies, dependents, topologicalOrder: nodes };
}

let manager: StateManager;

beforeEach(async () => {
  manager = await StateManager.init(await fs.mkdtemp(path.join(tmpdir(), "konte-keep-graph-")));
});

function accept(address: string, fields: Record<string, unknown> = {}): string {
  const variantId = manager.reserveVariantId(address);
  Object.assign(manager.getAssetState(address).variants![variantId]!, {
    file: `${variantId}.png`,
    outputHash: `out-${variantId}`,
    ...fields,
  });
  manager.setAccepted(address, variantId);
  return variantId;
}

const build = (edges: Array<[string, string]>) =>
  buildKeepGraph({
    manager,
    graph: graphOf(edges),
    stages: [
      { stage: "reference", definition: reference },
      { stage: "animatic", definition: animatic },
    ],
  });

describe("buildKeepGraph", () => {
  it("asks about a plate and a timeline asset as units of their own", () => {
    accept(SHEET);
    accept(PLATE);
    accept(BG);

    const graph = build([
      [SHEET, PLATE],
      [SHEET, BG],
    ]);
    expect(graph.units[PLATE]).toEqual({ stage: "animatic", label: "Plate: front" });
    expect(graph.units[BG]).toEqual({ stage: "animatic", label: "Timeline: bg" });
    expect(graph.addresses[SHEET]!.consumers).toEqual([
      { address: PLATE, via: SHEET },
      { address: BG, via: SHEET },
    ]);
  });

  it("names a patched take of a deterministic asset as a verdict to keep or regenerate", () => {
    accept(BG);
    const source = manager.reserveVariantId(SMALL);
    manager.getAssetState(SMALL).variants![source]!.file = "small.png";
    accept(SMALL, { derivedFrom: source });

    const graph = build([[BG, SMALL]]);
    expect(graph.addresses[SMALL]!.rerollable).toBe(true);
    expect(graph.addresses[BG]!.consumers).toEqual([{ address: SMALL, via: BG }]);
  });
});
