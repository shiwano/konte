import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../core/state/index.js";
import type { AnimaticDefinition } from "../../core/types/index.js";
import { staleRefreshStep } from "../stale-refresh-step.js";

const ADDRESS = "animatic:shot.01.first";
let tmpDir: string;
let manager: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-refresh-step-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// `v-old` was made under the definition that is current again (a reverted edit); `v-new` under the
// edit that has since been undone.
function twoTakes(): void {
  const target = manager.ensureAssetState(ADDRESS);
  target.variants = {
    "v-old": {
      status: "none",
      file: "old.png",
      definitionHash: "CURRENT",
      outputHash: "old",
      createdAt: "2026-01-01T00:00:01.000Z",
      readyAt: "2026-01-01T00:00:01.000Z",
      inputFingerprints: {},
      metadata: {},
    },
    "v-new": {
      status: "none",
      file: "new.png",
      definitionHash: "EDITED",
      outputHash: "new",
      createdAt: "2026-01-01T00:00:02.000Z",
      readyAt: "2026-01-01T00:00:02.000Z",
      inputFingerprints: {},
      metadata: {},
    },
  };
  manager.useResolutionDefinitions({
    definitionHash: () => "CURRENT",
    isDeterministic: () => false,
  });
}

// A board whose one panel has its movement written — what the accept branch demands.
function boardWithMovement(blocking: string | undefined): AnimaticDefinition {
  return {
    shots: [
      {
        id: "01",
        duration: 3,
        assets: {},
        panels: [{ assetPath: ADDRESS, blocking, camera: "holds" }],
      },
    ],
  } as unknown as AnimaticDefinition;
}

describe("staleRefreshStep", () => {
  it("names the take that matches the current definition", () => {
    twoTakes();
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        animatic: boardWithMovement("steps in"),
      }),
    ).toEqual({ kind: "accept", variantId: "v-old" });
  });

  it("names what the accept is owed rather than an accept that would be refused", () => {
    // The panel is still owed its `blocking`. Neither an accept nor a reroll is the step: the
    // material exists, and paying for another take would not write the movement.
    twoTakes();
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        animatic: boardWithMovement(undefined),
      }),
    ).toEqual({
      kind: "prerequisite",
      variantId: "v-old",
      missing: ["blocking"],
      writeIn: "animatic.tsx",
    });
  });

  it("offers no accept over a board that could not be read", () => {
    // undefined, not null: `konte accept` loads the board strictly and would refuse.
    twoTakes();
    expect(
      staleRefreshStep({ manager, address: ADDRESS, variantId: "v-new", animatic: undefined }),
    ).toEqual({ kind: "reroll" });
  });

  // A deterministic asset has one outcome, so `reroll` refuses it; the stage generate is what
  // re-bakes it, over its accept included.
  it("re-bakes a deterministic take with generate rather than a reroll it would be refused", () => {
    twoTakes();
    delete manager.getAssetState(ADDRESS).variants!["v-old"];
    manager.useResolutionDefinitions({
      definitionHash: () => "CURRENT",
      isDeterministic: () => true,
    });
    expect(
      staleRefreshStep({ manager, address: ADDRESS, variantId: "v-new", animatic: undefined }),
    ).toEqual({ kind: "generate", stage: "animatic" });
  });

  it("asks for nothing when the address's accepted take is itself current", () => {
    twoTakes();
    manager.setAccepted(ADDRESS, "v-old");
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        animatic: boardWithMovement("steps in"),
      }),
    ).toEqual({ kind: "none" });
  });

  it("re-applies a patch output's correction rather than rerolling its original", () => {
    twoTakes();
    manager.getAssetState(ADDRESS).variants!["v-new"]!.derivedFrom = "v-old";
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        patchHashes: new Map([["v-old", "h"]]),
        animatic: boardWithMovement("steps in"),
      }),
    ).toEqual({ kind: "patch-apply", sourceVariantId: "v-old" });
  });

  it("still re-applies a correction beside a healthy accept — `status` lists it either way", () => {
    twoTakes();
    manager.getAssetState(ADDRESS).variants!["v-new"]!.derivedFrom = "v-old";
    manager.setAccepted(ADDRESS, "v-old");
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        patchHashes: new Map([["v-old", "h"]]),
        animatic: boardWithMovement("steps in"),
      }),
    ).toEqual({ kind: "patch-apply", sourceVariantId: "v-old" });
  });

  it("prunes instead once the patch script it was made by is gone", () => {
    twoTakes();
    manager.getAssetState(ADDRESS).variants!["v-new"]!.derivedFrom = "v-old";
    expect(
      staleRefreshStep({
        manager,
        address: ADDRESS,
        variantId: "v-new",
        patchHashes: new Map(),
        animatic: boardWithMovement("steps in"),
      }),
    ).toEqual({ kind: "prune" });
  });
});
