import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getAssetEntry } from "../../../../core/address.js";
import { writeDefinitionSnapshot } from "../../../../core/definition-snapshot.js";
import type { AssetDefinition } from "../../../../core/types/index.js";
import { computeDefinitionHash } from "../../../../core/definition-hash.js";
import { applyResolutionDefinitions } from "../../../../core/definition-hashes.js";
import { Composition, Image } from "../../../../core/dsl/composition/index.js";
import { defineComfyAsset } from "../../../../core/dsl/comfy-asset.js";
import { asset, defineAnimatic, defineDirection, defineVideo } from "../../../../core/dsl/index.js";
import { KonteError } from "../../../../core/errors.js";
import { buildDependencyGraph } from "../../../../core/graph.js";
import { StateManager } from "../../../../core/state/index.js";
import { directionDefaults } from "../../../../core/__tests__/helpers/direction.js";
import { selectGenerationAssets } from "../../../../core/generation-selection.js";
import { unsubmittedGenerationError } from "../generation-gate.js";

const still = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ kind: "graphic", id: "01", role: "hero", action: "the title card", duration: 2 }],
  },
});

const animatic = defineAnimatic(direction, {
  timeline: ({ graphicShot }) => ({
    shots: graphicShot("01", () => (
      <Composition>
        <div>konte</div>
      </Composition>
    )),
  }),
});

const cut = (prompt: string) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => ({
      shots: graphicShot("01", () => (
        <Composition>
          <Image src={asset("card", still, { prompt })} />
        </Composition>
      )),
    }),
  });

const CARD = "video:shot.01.card";

let dir: string;
let manager: StateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-generation-gate-"));
  manager = await StateManager.init(dir);
});

function addTake(
  video: ReturnType<typeof cut>,
  opts: { file?: boolean; error?: string } = {},
): string {
  const id = manager.reserveVariantId(CARD);
  const variant = manager.getAssetState(CARD).variants![id]!;
  if (opts.file !== false) {
    variant.file = `assets/${id}.png`;
    variant.outputHash = `out-${id}`;
  }
  if (opts.error) variant.metadata = { error: opts.error };
  variant.definitionHash = computeDefinitionHash(video.shots[0]!.assets.card!);
  return id;
}

async function gate(video: ReturnType<typeof cut>): Promise<KonteError | null> {
  const definitions = { reference: null, animatic, video } as never;
  await applyResolutionDefinitions({ videoRoot: dir, definitions, state: manager.getState() });
  const { spending } = selectGenerationAssets({
    definitions,
    stage: "video",
    manager,
    graph: buildDependencyGraph(video, animatic, null),
  });
  return unsubmittedGenerationError(manager, definitions, spending);
}

describe("opening the video review while generate would still submit work", () => {
  it("refuses an asset never generated, naming it", async () => {
    const err = await gate(cut("a card"));
    expect(err?.code).toBe("GENERATION_UNSUBMITTED");
    expect(err?.items).toEqual([`  ${CARD} — never generated`]);
  });

  it("refuses an asset whose only take went stale, naming why", async () => {
    const id = addTake(cut("a card"));
    const err = await gate(cut("a new card"));
    expect(err?.code).toBe("GENERATION_UNSUBMITTED");
    expect(err?.items).toEqual([`  ${CARD} — ${id} is stale (definition-stale)`]);
  });

  it("opens over a current take", async () => {
    addTake(cut("a card"));
    expect(await gate(cut("a card"))).toBeNull();
  });

  it("opens while a job is making the take", async () => {
    addTake(cut("a card"), { file: false });
    expect(await gate(cut("a card"))).toBeNull();
  });

  it("opens over a take stale only under its adapter, which the page draws", async () => {
    const video = cut("a card");
    const current = getAssetEntry(video, CARD) as Extract<AssetDefinition, { kind: "comfy" }>;
    const rekeyed = (record: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(record).map(([k, v]) => [k.replace(/^3\./, "4."), v]));
    const made = {
      ...current,
      inputs: rekeyed(current.inputs),
      inputLabels: rekeyed(current.inputLabels ?? {}) as Record<string, string>,
    };
    const id = addTake(video);
    manager.getAssetState(CARD).variants![id]!.definitionHash = computeDefinitionHash(made);
    writeDefinitionSnapshot(dir, CARD, id, made);
    expect(await gate(video)).toBeNull();
  });

  it("opens when the newest job failed", async () => {
    addTake(cut("a card"), { file: false, error: "boom" });
    expect(await gate(cut("a card"))).toBeNull();
  });
});
