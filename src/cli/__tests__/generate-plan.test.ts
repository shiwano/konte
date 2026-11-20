import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import type { DependencyGraph } from "../../core/graph.js";
import { StateManager } from "../../core/state/index.js";
import { JobManager } from "../../core/job-manager.js";
import type { AssetDefinition } from "../../core/types/index.js";
import { buildGeneratePlan, formatAcceptedStaleNotice } from "../generate-plan.js";
import {
  assetSkipReason,
  holdsJoblessReservation,
  inFlightVariantIds,
  liveGenerationVariantIds,
} from "../../core/generation-selection.js";

async function createManager(): Promise<StateManager> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
  return StateManager.init(dir);
}

const comfyDef = { kind: "comfy" } as unknown as AssetDefinition;
const fileDef = { kind: "file" } as unknown as AssetDefinition;

const HASH = "def-current";
const NO_JOBS: ReadonlySet<string> = new Set();

function graphOf(deps: Record<string, string[]>): DependencyGraph {
  return {
    dependencies: new Map(Object.entries(deps)),
    dependents: new Map(),
    topologicalOrder: Object.keys(deps),
    pendingReferences: [],
  };
}

describe("assetSkipReason", () => {
  const address = "video:shot.01.motion";
  const upstream = "video:shot.01.key";

  // `assetSkipReason` with `hash` installed as `address`'s current definition.
  function skipUnder(
    manager: StateManager,
    liveJobs: ReadonlySet<string>,
    hash: string,
    inputRebuilt?: boolean,
  ) {
    manager.useResolutionDefinitions({
      definitionHash: (a) => (a === address ? hash : null),
      isDeterministic: () => false,
    });
    return assetSkipReason(manager, liveJobs, address, inputRebuilt);
  }

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
    expect(skipUnder(manager, NO_JOBS, HASH)).toBeNull();
  });

  it("skips an unaccepted variant that is ready", async () => {
    const { manager } = await withReadyVariant();
    expect(skipUnder(manager, NO_JOBS, HASH)).toBe("ready");
  });

  it("generates a ready variant whose upstream the same run rebuilds", async () => {
    const { manager } = await withReadyVariant();
    expect(skipUnder(manager, NO_JOBS, HASH, true)).toBeNull();
  });

  it("keeps an accepted variant whose upstream the same run rebuilds", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.setAccepted(address, vid);
    expect(skipUnder(manager, NO_JOBS, HASH, true)).toBe("accepted");
  });

  it("generates when the only ready variant was dismissed", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.getAssetState(address).variants![vid]!.status = "dismissed";
    expect(skipUnder(manager, NO_JOBS, HASH)).toBeNull();
  });

  it("generates when the only variant is definition-stale and unaccepted", async () => {
    const { manager } = await withReadyVariant();
    expect(skipUnder(manager, NO_JOBS, "def-edited")).toBeNull();
  });

  it("generates when the only variant is input-stale and unaccepted", async () => {
    const { manager, vid } = await withReadyVariant();
    makeInputStale(manager, vid);
    expect(skipUnder(manager, NO_JOBS, HASH)).toBeNull();
  });

  it("skips an accepted variant that is ready", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.setAccepted(address, vid);
    expect(skipUnder(manager, NO_JOBS, HASH)).toBe("accepted");
  });

  // generate never draws a rival to a take a human accepted — that is reroll's job. A new variant
  // here would not resolve anyway.
  it("skips an accepted variant that is definition-stale", async () => {
    const { manager, vid } = await withReadyVariant();
    manager.setAccepted(address, vid);
    expect(skipUnder(manager, NO_JOBS, "def-edited")).toBe("accepted-stale");
  });

  it("skips an accepted variant that is input-stale as accepted", async () => {
    const { manager, vid } = await withReadyVariant();
    makeInputStale(manager, vid);
    manager.setAccepted(address, vid);
    expect(skipUnder(manager, NO_JOBS, HASH)).toBe("accepted");
  });

  it("reports an in-flight job before anything else", async () => {
    const { manager } = await withReadyVariant();
    const vid = manager.reserveVariantId(address);
    expect(skipUnder(manager, new Set([vid]), HASH)).toBe("active");
  });

  it("generates past a reservation whose job was never created", async () => {
    const manager = await createManager();
    manager.reserveVariantId(address);
    expect(skipUnder(manager, NO_JOBS, HASH)).toBeNull();
  });
});

describe("formatAcceptedStaleNotice", () => {
  it("is null when nothing is accepted-stale", () => {
    expect(formatAcceptedStaleNotice([])).toBeNull();
  });

  it("names each address with its cause, its step and the reroll that takes the edit", () => {
    const notice = formatAcceptedStaleNotice([
      {
        address: "video:shot.01.motion",
        cause: "definition-stale",
        step: "the accept stands",
        reroll: true,
      },
    ]);
    expect(notice).toContain("video:shot.01.motion: definition-stale");
    expect(notice).toContain("  the accept stands");
    expect(notice).toContain(
      "for a take of the edited definition: konte reroll video:shot.01.motion",
    );
  });

  it("names no reroll when the step settles the take", () => {
    const notice = formatAcceptedStaleNotice([
      {
        address: "video:shot.01.motion",
        cause: "definition-stale",
        step: "konte patch apply v-src",
        reroll: false,
      },
    ]);
    expect(notice).toContain("konte patch apply v-src");
    expect(notice).not.toContain("reroll");
  });

  it("offers the fork beside the reroll for a plate two shots stand on", () => {
    const notice = formatAcceptedStaleNotice([
      {
        address: "animatic:plate.deckLow",
        cause: "definition-stale",
        step: null,
        reroll: true,
        fork: { setupId: "deckLow", shotIds: ["06", "22"] },
      },
    ]);
    expect(notice).toContain("shared frame for shots 06, 22");
    expect(notice).toContain("for one shot: fork the setup");
    expect(notice).toContain("for all 2: konte reroll animatic:plate.deckLow");
  });
});

describe("inFlightVariantIds", () => {
  const address = "video:shot.01.motion";

  it("counts a fileless variant whose job is active", async () => {
    const manager = await createManager();
    const vid = manager.reserveVariantId(address);
    expect(inFlightVariantIds(manager.getState(), address, new Set([vid]))).toEqual([vid]);
  });

  it("excludes a fileless variant with no active job", async () => {
    const manager = await createManager();
    manager.reserveVariantId(address);
    expect(inFlightVariantIds(manager.getState(), address, NO_JOBS)).toEqual([]);
  });

  it("excludes a variant that has its file", async () => {
    const manager = await createManager();
    const vid = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![vid]!.file = "out.png";
    expect(inFlightVariantIds(manager.getState(), address, new Set([vid]))).toEqual([]);
  });
});

describe("liveGenerationVariantIds", () => {
  const address = "video:shot.01.motion";

  async function withJob(status: "queued" | "completed" | "failed") {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
    const manager = await StateManager.init(dir);
    const vid = manager.reserveVariantId(address);
    await manager.save();
    const jobManager = new JobManager(dir);
    await jobManager.createJob({ address, variantId: vid, resolvedDeps: {}, backendKind: "comfy" });
    if (status !== "queued") {
      await jobManager.putJob({ ...(await jobManager.getJob(vid)), status } as never);
    }
    return { dir, manager, vid, jobs: await jobManager.listJobs() };
  }

  it("counts a job not yet finished", async () => {
    const { dir, manager, vid, jobs } = await withJob("queued");
    expect(await liveGenerationVariantIds(dir, jobs, manager.getState())).toEqual(new Set([vid]));
  });

  it("counts a completed job whose file landed after the state was read", async () => {
    const { dir, manager, vid, jobs } = await withJob("completed");
    await StateManager.withLock(dir, async (m) => {
      m.getAssetState(address).variants![vid]!.file = "out.png";
    });
    expect(await liveGenerationVariantIds(dir, jobs, manager.getState())).toEqual(new Set([vid]));
  });

  it("leaves out a completed job whose take has no file on disk either", async () => {
    const { dir, manager, jobs } = await withJob("completed");
    expect(await liveGenerationVariantIds(dir, jobs, manager.getState())).toEqual(new Set());
  });

  it("leaves out a failed job", async () => {
    const { dir, manager, jobs } = await withJob("failed");
    expect(await liveGenerationVariantIds(dir, jobs, manager.getState())).toEqual(new Set());
  });
});

describe("holdsJoblessReservation", () => {
  it("finds a fileless take with no job until its job exists", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
    const manager = await StateManager.init(dir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    const jobManager = new JobManager(dir);
    expect(holdsJoblessReservation(manager.getState(), await jobManager.listJobs())).toBe(true);

    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: vid,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    expect(holdsJoblessReservation(manager.getState(), await jobManager.listJobs())).toBe(false);
  });
});

describe("StateManager.writersSettled", () => {
  it("resolves only after the writer holding the state lock releases it", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-genorch-"));
    await StateManager.init(dir);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const writer = StateManager.withLock(dir, async () => {
      entered();
      await held;
    });
    await inside;

    let settled = false;
    const waiting = StateManager.writersSettled(dir).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    release();
    await Promise.all([writer, waiting]);
    expect(settled).toBe(true);
  });
});

describe("buildGeneratePlan", () => {
  const defs: Record<string, AssetDefinition> = {
    "video:shot.01.key": comfyDef,
    "video:shot.01.motion": comfyDef,
    "video:timeline.bgm": fileDef,
  };
  const getAssetDef = (address: string) => defs[address]!;

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
      liveJobs: NO_JOBS,
      stageAddresses: new Set(["video:shot.01.key", "video:shot.01.motion"]),
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
      liveJobs: NO_JOBS,
      stageAddresses: new Set([key, "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === key)?.action).toBe("skip");
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("start");
    expect(plan.summary).toMatchObject({ start: 1, skip: 1 });
  });

  it("marks a ready asset whose upstream this run rebuilds as wait", async () => {
    const manager = await createManager();
    const key = "video:shot.01.key";
    const motion = "video:shot.01.motion";
    const keyVid = manager.reserveVariantId(key);
    Object.assign(manager.getAssetState(key).variants![keyVid]!, {
      file: "key.png",
      outputHash: "key-old",
      definitionHash: "def-edited-away",
    });
    const motionVid = manager.reserveVariantId(motion);
    Object.assign(manager.getAssetState(motion).variants![motionVid]!, {
      file: "motion.mp4",
      definitionHash: computeDefinitionHash(comfyDef),
      inputFingerprints: { [key]: "key-old" },
    });
    manager.useResolutionDefinitions({
      definitionHash: () => computeDefinitionHash(comfyDef),
      isDeterministic: () => false,
    });

    const plan = buildGeneratePlan({
      levels: [[key], [motion]],
      graph: graphOf({ [key]: [], [motion]: [key] }),
      manager,
      liveJobs: NO_JOBS,
      stageAddresses: new Set([key, motion]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === key)?.action).toBe("start");
    expect(entries.find((e) => e.address === motion)?.action).toBe("wait");
  });

  // A generated-but-in-flight upstream has a file only from a previous take; the real run makes
  // its dependent wait for the fresh one (hasActiveJobFor), so the plan must too.
  it("marks an asset whose dep has an active job as wait", async () => {
    const manager = await createManager();
    const key = "video:shot.01.key";
    const oldVid = manager.reserveVariantId(key);
    manager.getAssetState(key).variants![oldVid]!.file = "old-key.png";
    const activeVid = manager.reserveVariantId(key);

    const plan = buildGeneratePlan({
      levels: [[key], ["video:shot.01.motion"]],
      graph: graphOf({
        "video:shot.01.key": [],
        "video:shot.01.motion": ["video:shot.01.key"],
      }),
      manager,
      liveJobs: new Set([activeVid]),
      stageAddresses: new Set([key, "video:shot.01.motion"]),
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
    const activeVid = manager.reserveVariantId(board);

    const plan = buildGeneratePlan({
      levels: [[board], ["video:shot.01.motion"]],
      graph: graphOf({ "video:shot.01.motion": [board] }),
      manager,
      liveJobs: new Set([activeVid]),
      stageAddresses: new Set(["video:shot.01.motion"]),
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
      liveJobs: NO_JOBS,
      stageAddresses: new Set(["video:timeline.bgm", "video:shot.01.motion"]),
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
      liveJobs: NO_JOBS,
      stageAddresses: new Set([bgm, "video:shot.01.motion"]),
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
    const activeVid = manager.reserveVariantId(active);

    const plan = buildGeneratePlan({
      levels: [["video:shot.01.key", "video:shot.01.motion"]],
      graph: graphOf({ "video:shot.01.key": [], "video:shot.01.motion": [] }),
      manager,
      liveJobs: new Set([activeVid]),
      stageAddresses: new Set(["video:shot.01.key", "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.every((e) => e.action === "skip")).toBe(true);
    expect(plan.summary.skip).toBe(2);
  });

  it("starts an asset whose only fileless take has no job", async () => {
    const manager = await createManager();
    const key = "video:shot.01.key";
    manager.reserveVariantId(key);

    const plan = buildGeneratePlan({
      levels: [[key], ["video:shot.01.motion"]],
      graph: graphOf({ [key]: [], "video:shot.01.motion": [key] }),
      manager,
      liveJobs: NO_JOBS,
      stageAddresses: new Set([key, "video:shot.01.motion"]),
      variantCount: 1,
      getAssetDef,
    });

    const entries = plan.levels.flatMap((l) => l.entries);
    expect(entries.find((e) => e.address === key)?.action).toBe("start");
    expect(entries.find((e) => e.address === "video:shot.01.motion")?.action).toBe("wait");
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
      liveJobs: NO_JOBS,
      stageAddresses: new Set(["video:shot.01.key", "video:shot.01.motion"]),
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
      liveJobs: NO_JOBS,
      stageAddresses: new Set(["video:timeline.bgm"]),
      variantCount: 1,
      getAssetDef,
    } as const;

    const plan = buildGeneratePlan(common);
    expect(plan.levels[0]!.entries[0]!.action).toBe("synced");
  });
});
