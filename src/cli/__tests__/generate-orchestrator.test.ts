import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "../../core/graph.js";
import { StateManager } from "../../core/state/index.js";
import { comfyModelJobId } from "../../core/job-manager.js";
import type { AssetDefinition, ComfyModelDeclaration } from "../../core/types/index.js";
import {
  assetSkipReason,
  buildGeneratePlan,
  collectComfyDownloads,
  formatAcceptedStaleNotice,
  formatComfyDownloadNotice,
  getActiveVariantIds,
} from "../generate-orchestrator.js";

async function createManager(): Promise<StateManager> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
  return StateManager.init(dir);
}

const comfyDef = { kind: "comfy" } as unknown as AssetDefinition;
const fileDef = { kind: "file" } as unknown as AssetDefinition;

const HASH = "def-current";

function graphOf(deps: Record<string, string[]>): DependencyGraph {
  return {
    dependencies: new Map(Object.entries(deps)),
    dependents: new Map(),
    topologicalOrder: Object.keys(deps),
  };
}

describe("assetSkipReason", () => {
  const address = "video:shot.01.motion";
  const upstream = "video:shot.01.key";

  // A ready variant of `address`: has a file and carries the current definition hash.
  async function withReadyVariant(): Promise<{ manager: StateManager; vid: string }> {
    const manager = await createManager();
    const vid = manager.reserveVariantId(address);
    const variant = manager.getAssetState(address).variants![vid]!;
    variant.file = "out.png";
    variant.definitionHash = HASH;
    return { manager, vid };
  }

  // Make `address`'s variant input-stale by accepting an upstream whose output hash no
  // longer matches the fingerprint the variant recorded.
  function makeInputStale(manager: StateManager, vid: string): void {
    const keyVid = manager.reserveVariantId(upstream);
    const keyVariant = manager.getAssetState(upstream).variants![keyVid]!;
    keyVariant.file = "key.png";
    keyVariant.outputHash = "hash-current";
    manager.setAccepted(upstream, keyVid);
    manager.getAssetState(address).variants![vid]!.inputFingerprints = {
      [upstream]: "hash-recorded",
    };
  }

  it("generates when no variants exist", async () => {
    const manager = await createManager();
    expect(assetSkipReason(manager, address, HASH)).toBeNull();
  });

  it("skips an unaccepted variant that is ready", async () => {
    const { manager } = await withReadyVariant();
    expect(assetSkipReason(manager, address, HASH)).toBe("ready");
  });

  it("generates when the only ready variant was dismissed", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.getAssetState(address).variants![vid]!.status = "dismissed";
    expect(assetSkipReason(manager, address, HASH)).toBeNull();
  });

  it("generates when the only variant is definition-stale and unaccepted", async () => {
    const { manager } = await withReadyVariant();
    expect(assetSkipReason(manager, address, "def-edited")).toBeNull();
  });

  it("generates when the only variant is input-stale and unaccepted", async () => {
    const { manager, vid } = await withReadyVariant();
    makeInputStale(manager, vid);
    expect(assetSkipReason(manager, address, HASH)).toBeNull();
  });

  it("skips an accepted variant that is ready", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.setAccepted(address, vid);
    expect(assetSkipReason(manager, address, HASH)).toBe("accepted");
  });

  // generate never replaces a take a human accepted — that is reroll's job, behind a
  // confirmation that drops the accept. A new variant here would not resolve anyway.
  it("skips an accepted variant that is definition-stale", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.setAccepted(address, vid);
    expect(assetSkipReason(manager, address, "def-edited")).toBe("accepted-stale");
  });

  it("skips an accepted variant that is input-stale as accepted", async () => {
    const { manager, vid } = await withReadyVariant();
    makeInputStale(manager, vid);
    manager.setAccepted(address, vid);
    expect(assetSkipReason(manager, address, HASH)).toBe("accepted");
  });

  it("reports an in-flight job before anything else", async () => {
    const { manager } = await withReadyVariant();
    manager.reserveVariantId(address);
    expect(assetSkipReason(manager, address, HASH)).toBe("active");
  });
});

describe("formatAcceptedStaleNotice", () => {
  it("is null when nothing is accepted-stale", () => {
    expect(formatAcceptedStaleNotice([])).toBeNull();
  });

  it("names each address with its cause and the command that replaces it", () => {
    const notice = formatAcceptedStaleNotice([
      {
        address: "video:shot.01.motion",
        cause: "definition-stale",
        command: "konte reroll video:shot.01.motion",
      },
    ]);
    expect(notice).toContain("video:shot.01.motion: definition-stale");
    expect(notice).toContain("konte reroll video:shot.01.motion");
  });

  it("offers the fork beside the reroll for a plate two shots stand on", () => {
    const notice = formatAcceptedStaleNotice([
      {
        address: "animatic:plate.deckLow",
        cause: "definition-stale",
        command: "konte reroll animatic:plate.deckLow",
        fork: { setupId: "deckLow", shotIds: ["06", "22"] },
      },
    ]);
    expect(notice).toContain("shared frame for shots 06, 22");
    expect(notice).toContain("for one shot: fork the setup");
    expect(notice).toContain("for all 2: konte reroll animatic:plate.deckLow");
  });
});

describe("getActiveVariantIds", () => {
  it("counts a fileless variant with no error as active", async () => {
    const manager = await createManager();
    const address = "video:shot.01.motion";
    const vid = manager.reserveVariantId(address);
    expect(getActiveVariantIds(manager, address)).toEqual([vid]);
  });

  it("excludes a failed variant (no file, metadata.error) so a re-run regenerates", async () => {
    const manager = await createManager();
    const address = "video:shot.01.motion";
    const vid = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![vid]!.metadata = { error: "boom" };
    expect(getActiveVariantIds(manager, address)).toEqual([]);
  });

  it("excludes a cancelled variant (no file, metadata.cancelledAt) so a re-run regenerates", async () => {
    const manager = await createManager();
    const address = "video:shot.01.motion";
    const vid = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![vid]!.metadata = {
      cancelledAt: "2025-01-01T00:00:00Z",
    };
    expect(getActiveVariantIds(manager, address)).toEqual([]);
  });
});

describe("buildGeneratePlan", () => {
  const defs: Record<string, AssetDefinition> = {
    "video:shot.01.key": comfyDef,
    "video:shot.01.motion": comfyDef,
    "video:timeline.bgm": fileDef,
  };
  const getAssetDef = (assetPath: string) => defs[assetPath]!;

  it("marks root assets as start and assets waiting on an upstream this run builds as wait", async () => {
    const manager = await createManager();
    const graph = graphOf({
      "video:shot.01.key": [],
      "video:shot.01.motion": ["video:shot.01.key"],
    });
    const plan = buildGeneratePlan({
      levels: [["video:shot.01.key"], ["video:shot.01.motion"]],
      graph,
      manager,
      stageAssetPaths: new Set(["video:shot.01.key", "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === "video:shot.01.key")?.action).toBe("start");
    const motion = entries.find((e) => e.address === "video:shot.01.motion");
    expect(motion?.action).toBe("wait");
    expect(motion?.deps).toEqual(["video:shot.01.key"]);
    expect(plan.summary).toMatchObject({ start: 1, wait: 1 });
  });

  // Having deps is not what makes a take wait — an unmet dep is. An asset whose upstream is
  // already generated starts as surely as a root one, so the plan must not call it pending
  // just because the real run routes it through the pending-job path.
  it("marks an asset whose deps are already generated as start", async () => {
    const manager = await createManager();
    const key = "video:shot.01.key";
    const keyVid = manager.reserveVariantId(key);
    manager.getAssetState(key).variants![keyVid]!.file = "key.png";
    manager.setAccepted(key, keyVid);

    const plan = buildGeneratePlan({
      levels: [[key], ["video:shot.01.motion"]],
      graph: graphOf({
        "video:shot.01.key": [],
        "video:shot.01.motion": ["video:shot.01.key"],
      }),
      manager,
      stageAssetPaths: new Set([key, "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === key)?.action).toBe("skip");
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("start");
    expect(plan.summary).toMatchObject({ start: 1, skip: 1 });
  });

  // A generated-but-in-flight upstream has a file only from a previous take; the real run makes
  // its dependent wait for the fresh one (hasActiveJobFor), so the plan must too.
  it("marks an asset whose dep has an active job as wait", async () => {
    const manager = await createManager();
    const key = "video:shot.01.key";
    const oldVid = manager.reserveVariantId(key);
    manager.getAssetState(key).variants![oldVid]!.file = "old-key.png";
    manager.reserveVariantId(key); // fileless -> active job

    const plan = buildGeneratePlan({
      levels: [[key], ["video:shot.01.motion"]],
      graph: graphOf({
        "video:shot.01.key": [],
        "video:shot.01.motion": ["video:shot.01.key"],
      }),
      manager,
      stageAssetPaths: new Set([key, "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === key)?.action).toBe("skip");
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("wait");
  });

  // The same in-flight upstream, but one stage up: a cross-stage dep is filtered out of the
  // planned levels entirely, so the wait can only be seen by asking state about the dep itself.
  it("marks an asset whose cross-stage dep has an active job as wait", async () => {
    const manager = await createManager();
    const board = "animatic:shot.01.keyframe";
    const oldVid = manager.reserveVariantId(board);
    manager.getAssetState(board).variants![oldVid]!.file = "old-board.png";
    manager.reserveVariantId(board); // fileless -> active job

    const plan = buildGeneratePlan({
      levels: [[board], ["video:shot.01.motion"]],
      graph: graphOf({ "video:shot.01.motion": [board] }),
      manager,
      stageAssetPaths: new Set(["video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    expect(plan.levels.flatMap((l) => l.entries).map((e) => e.address)).toEqual([
      "video:shot.01.motion",
    ]);
    expect(plan.levels[0]!.entries[0]!.action).toBe("wait");
  });

  // A `file` dep whose path is absent leaves no variant behind (the caller syncs before
  // planning), so its consumer has nothing to build on — a wait, not a start.
  it("marks an asset whose file dep has no synced variant as wait", async () => {
    const manager = await createManager();
    const plan = buildGeneratePlan({
      levels: [["video:timeline.bgm"], ["video:shot.01.motion"]],
      graph: graphOf({
        "video:timeline.bgm": [],
        "video:shot.01.motion": ["video:timeline.bgm"],
      }),
      manager,
      stageAssetPaths: new Set(["video:timeline.bgm", "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === "video:timeline.bgm")?.action).toBe("synced");
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("wait");
  });

  it("marks an asset whose file dep is synced as start", async () => {
    const manager = await createManager();
    const bgm = "video:timeline.bgm";
    const bgmVid = manager.reserveVariantId(bgm);
    manager.getAssetState(bgm).variants![bgmVid]!.file = "assets/files/bgm.mp3";

    const plan = buildGeneratePlan({
      levels: [[bgm], ["video:shot.01.motion"]],
      graph: graphOf({
        "video:timeline.bgm": [],
        "video:shot.01.motion": [bgm],
      }),
      manager,
      stageAssetPaths: new Set([bgm, "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("start");
  });

  it("skips ready and active assets", async () => {
    const manager = await createManager();
    const ready = "video:shot.01.key";
    const readyVid = manager.reserveVariantId(ready);
    manager.getAssetState(ready).variants![readyVid]!.file = "key.png";

    const active = "video:shot.01.motion";
    manager.reserveVariantId(active); // no file -> active job

    const plan = buildGeneratePlan({
      levels: [["video:shot.01.key", "video:shot.01.motion"]],
      graph: graphOf({ "video:shot.01.key": [], "video:shot.01.motion": [] }),
      manager,
      stageAssetPaths: new Set(["video:shot.01.key", "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.every((e) => e.action === "skip")).toBe(true);
    expect(plan.summary.skip).toBe(2);
  });

  it("numbers shown levels sequentially across cross-stage gaps", async () => {
    const manager = await createManager();
    // Global graph levels alternate stages, so the video stage only occupies the
    // sparse global indices 1 and 3 — those must show as sequential levels 0, 1.
    const plan = buildGeneratePlan({
      levels: [
        ["animatic:shot.01.first"],
        ["video:shot.01.key"],
        ["animatic:shot.01.second"],
        ["video:shot.01.motion"],
      ],
      graph: graphOf({
        "video:shot.01.key": [],
        "video:shot.01.motion": ["video:shot.01.key"],
      }),
      manager,
      stageAssetPaths: new Set(["video:shot.01.key", "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    expect(plan.levels.map((l) => l.level)).toEqual([0, 1]);
  });

  it("labels file assets as synced in both stages", async () => {
    const manager = await createManager();
    const common = {
      levels: [["video:timeline.bgm"]],
      graph: graphOf({ "video:timeline.bgm": [] }),
      manager,
      stageAssetPaths: new Set(["video:timeline.bgm"]),
      variantCount: 1,
      getAssetDef,
    } as const;

    const plan = buildGeneratePlan(common);
    expect(plan.levels[0]!.entries[0]!.action).toBe("synced");
  });
});

function comfyAsset(opts: {
  models?: Array<{ filename: string; type: string; displayName?: string }>;
  nodes?: Array<{ id: string; displayName?: string }>;
}): AssetDefinition {
  return { kind: "comfy", ...opts } as unknown as AssetDefinition;
}

describe("collectComfyDownloads", () => {
  it("returns empty arrays when there are no comfy entries", () => {
    expect(collectComfyDownloads([], new Set(), new Set())).toEqual({ models: [], nodes: [] });
  });

  it("skips non-comfy entries", () => {
    const result = collectComfyDownloads(
      [{ address: "video:timeline.bgm", def: fileDef }],
      new Set(["x.safetensors"]),
      new Set(),
    );
    expect(result).toEqual({ models: [], nodes: [] });
  });

  it("includes only declarations flagged missing", () => {
    const present = { filename: "present.safetensors", type: "checkpoint" as const };
    const missing = { filename: "missing.safetensors", type: "lora" as const };
    const def = comfyAsset({ models: [present, missing] });
    const result = collectComfyDownloads(
      [{ address: "video:shot.01.motion", def }],
      new Set([comfyModelJobId(missing as ComfyModelDeclaration)]),
      new Set(),
    );
    expect(result.models).toEqual([
      {
        filename: "missing.safetensors",
        type: "lora",
        savePath: undefined,
        displayName: undefined,
        addresses: ["video:shot.01.motion"],
      },
    ]);
  });

  it("keeps one entry per install target when a filename repeats across savePaths", () => {
    // A directory-shaped model contributes several files sharing a name; keying by filename
    // alone would collapse them into one line and hide a download.
    const root = { filename: "config.json", type: "checkpoint" as const, savePath: "TTS/m" };
    const nested = { ...root, savePath: "TTS/m/speech_tokenizer" };
    const def = comfyAsset({ models: [root, nested] });
    const result = collectComfyDownloads(
      [{ address: "reference:narration", def }],
      new Set([root, nested].map((m) => comfyModelJobId(m as ComfyModelDeclaration))),
      new Set(),
    );
    expect(result.models.map((m) => m.savePath)).toEqual(["TTS/m", "TTS/m/speech_tokenizer"]);
  });

  it("dedups a shared model and aggregates its addresses", () => {
    const base = { filename: "base.safetensors", type: "checkpoint" as const };
    const a = comfyAsset({ models: [base] });
    const b = comfyAsset({ models: [base] });
    const result = collectComfyDownloads(
      [
        { address: "video:shot.01.motion", def: a },
        { address: "video:shot.02.motion", def: b },
      ],
      new Set([comfyModelJobId(base as ComfyModelDeclaration)]),
      new Set(),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.addresses).toEqual(["video:shot.01.motion", "video:shot.02.motion"]);
  });

  it("carries type/displayName for models, and the cnr_id for nodes", () => {
    const model = {
      filename: "m.safetensors",
      type: "diffusion_model" as const,
      displayName: "My Model",
    };
    const def = comfyAsset({
      models: [model],
      nodes: [{ id: "ComfyUI-SeedVR2_VideoUpscaler" }],
    });
    const result = collectComfyDownloads(
      [{ address: "video:shot.01.motion", def }],
      new Set([comfyModelJobId(model as ComfyModelDeclaration)]),
      new Set(["ComfyUI-SeedVR2_VideoUpscaler"]),
    );
    expect(result.models[0]).toMatchObject({ type: "diffusion_model", displayName: "My Model" });
    expect(result.nodes[0]).toMatchObject({ id: "ComfyUI-SeedVR2_VideoUpscaler" });
  });
});

describe("formatComfyDownloadNotice", () => {
  it("returns null when nothing is pending", () => {
    expect(formatComfyDownloadNotice({ models: [], nodes: [] })).toBeNull();
  });

  it("uses distinct download/install verbs and includes the address", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "sd3.5_large.safetensors",
          type: "checkpoint",
          addresses: ["video:shot.01.motion"],
        },
      ],
      nodes: [{ id: "ComfyUI-SeedVR2_VideoUpscaler", addresses: ["video:shot.02.motion"] }],
    });
    expect(text).toContain("skipped if already present");
    expect(text).toContain(
      "download  sd3.5_large.safetensors (checkpoint)  — video:shot.01.motion",
    );
    expect(text).toContain(
      "install   ComfyUI-SeedVR2_VideoUpscaler (custom node)  — video:shot.02.motion",
    );
  });

  it("prefers displayName as the label", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "m.safetensors",
          type: "lora",
          displayName: "Pretty Name",
          addresses: ["video:shot.01.motion"],
        },
      ],
      nodes: [],
    });
    expect(text).toContain("download  Pretty Name (lora)");
    expect(text).not.toContain("m.safetensors");
  });

  it("abbreviates multiple addresses to the first plus a count", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "base.safetensors",
          type: "checkpoint",
          addresses: ["video:shot.01.motion", "video:shot.02.motion", "video:shot.03.motion"],
        },
      ],
      nodes: [],
    });
    expect(text).toContain("— video:shot.01.motion (+2 more)");
    expect(text).not.toContain("shot.02.motion");
  });
});
