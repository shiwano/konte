import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { JobIndex } from "../job-index.js";
import { describePendingJob, resolveJobDeps } from "../pending-jobs.js";
import { resolveRefs } from "../ref-resolver.js";
import type { StateManager } from "../state/index.js";
import type { GenerationJob, JobRecord, KonteState, VariantState } from "../types/index.js";
import { createStalenessCache } from "../staleness.js";

function genJob(overrides: Partial<GenerationJob> & { variantId: string }): GenerationJob {
  return {
    id: overrides.variantId,
    kind: "generation",
    address: "video:shot.01.motion",
    status: "pending",
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    backendKind: "comfy",
    backendJobId: null,
    submissionStartedAt: null,
    progress: null,
    error: null,
    outputFiles: [],
    metadata: {},
    provenance: {
      workflowHash: null,
      inputHash: null,
      resolvedDependencies: {},
      compositionCacheKeys: {},
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    processingStartedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
    ...overrides,
  };
}

function modelJob(id: string, status: JobRecord["status"]): JobRecord {
  return {
    id,
    kind: "comfy-model-download",
    status,
    backendKind: "comfy",
    dependsOnJobs: [],
    lease: null,
    progress: null,
    error: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    processingStartedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
    model: { type: "checkpoint", filename: `${id}.safetensors`, url: "https://example.com/m" },
  } as JobRecord;
}

function stateWithFiles(addresses: string[]): KonteState {
  const assets: KonteState["assets"] = {};
  for (const addr of addresses) {
    assets[addr] = {
      variants: {
        "v-dep": {
          status: "accepted",
          outputHash: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          inputFingerprints: {},
          file: "out/dep.png",
          definitionHash: null,
          metadata: {},
        },
      },
      feedback: [],
    } as KonteState["assets"][string];
  }
  return { schemaVersion: 1, assets };
}

describe("describePendingJob", () => {
  it("is submittable when every asset dependency already has a file", () => {
    const job = genJob({ variantId: "v-a", dependsOnAssets: ["video:timeline.character"] });
    const state = stateWithFiles(["video:timeline.character"]);
    expect(describePendingJob(job, state, new JobIndex([]))).toEqual({ submittable: true });
  });

  it("waits on the resolved address of an unsatisfied asset dependency", () => {
    const job = genJob({ variantId: "v-b", dependsOnAssets: ["video:timeline.character"] });
    const state = stateWithFiles([]); // dependency has no file
    expect(describePendingJob(job, state, new JobIndex([]))).toEqual({
      submittable: false,
      waitingOn: ["video:timeline.character"],
    });
  });

  it("waits on an upstream still being regenerated even when a stale variant has a file", () => {
    const job = genJob({ variantId: "v-b2", dependsOnAssets: ["video:timeline.character"] });
    const state = stateWithFiles(["video:timeline.character"]); // stale variant present
    const upstream = genJob({
      variantId: "v-up",
      address: "video:timeline.character",
      status: "running",
    });
    expect(describePendingJob(job, state, new JobIndex([upstream]))).toEqual({
      submittable: false,
      waitingOn: ["video:timeline.character"],
    });
  });

  it("waits on a not-ready model download, collapsed to a count", () => {
    const job = genJob({ variantId: "v-c", dependsOnJobs: ["cmd-1"] });
    const jobs = [modelJob("cmd-1", "running")];
    expect(describePendingJob(job, stateWithFiles([]), new JobIndex(jobs))).toEqual({
      submittable: false,
      waitingOn: ["1 model"],
    });
  });

  it("is submittable once the model download is ready", () => {
    const job = genJob({ variantId: "v-d", dependsOnJobs: ["cmd-1"] });
    const jobs = [modelJob("cmd-1", "completed")];
    expect(describePendingJob(job, stateWithFiles([]), new JobIndex(jobs))).toEqual({
      submittable: true,
    });
  });

  it("combines unsatisfied asset and model waits, pluralizing models", () => {
    const job = genJob({
      variantId: "v-e",
      dependsOnAssets: ["video:timeline.character"],
      dependsOnJobs: ["cmd-1", "cmd-2"],
    });
    const jobs = [modelJob("cmd-1", "pending"), modelJob("cmd-2", "pending")];
    expect(describePendingJob(job, stateWithFiles([]), new JobIndex(jobs))).toEqual({
      submittable: false,
      waitingOn: ["video:timeline.character", "2 models"],
    });
  });
});

describe("resolveJobDeps", () => {
  function variant(file: string | null, overrides: Partial<VariantState> = {}): VariantState {
    return {
      status: "none",
      outputHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      inputFingerprints: {},
      file,
      definitionHash: null,
      metadata: {},
      ...overrides,
    };
  }

  function asManager(state: KonteState): StateManager {
    // No definitions registered — the input axis alone, which is what these cases exercise.
    return {
      getState: () => state,
      stalenessCache: () => createStalenessCache(),
    } as StateManager;
  }

  function stateWithMotion(): KonteState {
    return {
      schemaVersion: 2,
      assets: {
        "video:shot.01.motion": {
          variants: {
            "v-old": variant("out/old.png", { status: "accepted" }),
            "v-new": variant("out/new.png"),
          },
          feedback: [],
        } as KonteState["assets"][string],
      },
    };
  }

  it("takes the pinned variant's file, ignoring an accepted older one", () => {
    const job = genJob({
      variantId: "v-enhanced",
      address: "video:shot.01.enhanced",
      dependsOnAssets: ["video:shot.01.motion"],
      metadata: { pinnedDeps: { "video:shot.01.motion": "v-new" } },
    });
    expect(resolveJobDeps(job, asManager(stateWithMotion()))).toEqual({
      "video:shot.01.motion": "out/new.png",
    });
  });

  it("resolves unpinned deps by the ordinary accepted/newest-ready rule", () => {
    const job = genJob({ variantId: "v-x", dependsOnAssets: ["video:shot.01.motion"] });
    expect(resolveJobDeps(job, asManager(stateWithMotion()))).toEqual({
      "video:shot.01.motion": "out/old.png",
    });
  });

  // A patch chain's earlier step: built from one take of its source, and input-stale the moment a
  // later take lands at that source address. The pin names the step's variant outright, so the
  // submit must not run it through resolution first.
  function stateWithStaleStep(): KonteState {
    return {
      schemaVersion: 2,
      assets: {
        "animatic:shot.23.first": {
          variants: {
            "v-src": variant("out/src.png", { outputHash: "hash-src" }),
            "v-later": variant("out/later.png", {
              outputHash: "hash-later",
              createdAt: "2026-01-02T00:00:00.000Z",
            }),
          },
          feedback: [],
        } as KonteState["assets"][string],
        "animatic:patch.v-src.flattened": {
          variants: {
            "v-step": variant("out/step.png", {
              inputFingerprints: { "animatic:shot.23.first": "hash-src" },
            }),
          },
          feedback: [],
        } as KonteState["assets"][string],
      },
    };
  }

  it("resolves a pinned dep whose own resolution has gone stale", () => {
    const state = stateWithStaleStep();
    // Control: the ordinary rule has nothing to offer for the stale step.
    expect(() => resolveRefs(["animatic:patch.v-src.flattened"], asManager(state))).toThrow(
      KonteError,
    );

    const job = genJob({
      variantId: "v-squared",
      address: "animatic:patch.v-src.squared",
      dependsOnAssets: ["animatic:shot.23.first", "animatic:patch.v-src.flattened"],
      metadata: {
        pinnedDeps: {
          "animatic:shot.23.first": "v-src",
          "animatic:patch.v-src.flattened": "v-step",
        },
      },
    });
    expect(resolveJobDeps(job, asManager(state))).toEqual({
      "animatic:shot.23.first": "out/src.png",
      "animatic:patch.v-src.flattened": "out/step.png",
    });
  });

  it("throws when the pinned variant has no file (state clobbered)", () => {
    const job = genJob({
      variantId: "v-enhanced",
      address: "video:shot.01.enhanced",
      dependsOnAssets: ["video:shot.01.motion"],
      metadata: { pinnedDeps: { "video:shot.01.motion": "v-missing" } },
    });
    expect(() => resolveJobDeps(job, asManager(stateWithMotion()))).toThrow(KonteError);
  });
});
