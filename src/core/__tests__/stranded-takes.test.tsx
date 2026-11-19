import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audio, Composition, Panel } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { ASSET_SITES } from "../dsl/adapter.js";
import { defineDirection } from "../dsl/direction.js";
import { adapters, asset, defineAnimatic } from "../dsl/index.js";
import { buildDependencyGraph } from "../graph.js";
import { StateManager } from "../state/index.js";
import { findStrandedTakes } from "../stranded-takes.js";
import type { JobRecord } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";

const ttsComfy = defineComfyAsset({
  allowedIn: ASSET_SITES,
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const stillComfy = defineComfyAsset({
  allowedIn: ASSET_SITES,
  workflow: "still.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "a cat", setup: "front", duration: 2, lineup: [] }],
  },
});

function animatic(fit: boolean, echo = false, unplayed = false, spare = false) {
  return defineAnimatic(direction, {
    timeline: ({ shot }) => ({
      shots: shot("01", () => {
        const vo = asset("vo", ttsComfy, { text: "meow" });
        const voFit = asset("voFit", adapters.audioRetime, { source: vo, duration: 1.9 });
        if (spare) asset("voSpare", adapters.audioRetime, { source: vo, duration: 1.8 });
        if (unplayed) {
          return (
            <Composition>
              <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
              <Audio src={asset("other", ttsComfy, { text: "mrrp" })} />
            </Composition>
          );
        }
        return (
          <Composition>
            <Panel src={asset("still", stillComfy, { prompt: "a cat" })} />
            <Audio src={fit ? voFit : vo} />
            {echo ? (
              <Audio src={asset("voEcho", adapters.audioRetime, { source: vo, duration: 1.8 })} />
            ) : null}
          </Composition>
        );
      }),
    }),
  });
}

const VO = "animatic:shot.01.vo";
const FIT = "animatic:shot.01.voFit";

function job(
  variantId: string,
  status: JobRecord["status"],
  pinned: string,
  address = FIT,
): JobRecord {
  return {
    id: variantId,
    kind: "generation",
    variantId,
    address,
    status,
    dependsOnAssets: [VO],
    dependsOnJobs: [],
    lease: null,
    backendKind: "local",
    backendJobId: null,
    progress: null,
    error: status === "failed" ? "fitting a 1.64s take into 1.9s runs it at 0.862x" : null,
    outputFiles: [],
    metadata: { pinnedDeps: { [VO]: pinned } },
    provenance: { workflowHash: null, inputHash: null, resolvedDependencies: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  } as unknown as JobRecord;
}

describe("findStrandedTakes", () => {
  let tmp: string;
  let manager: StateManager;
  let accepted: string;
  let rival: string;

  const take = (address: string, file: string | null): string => {
    const id = manager.reserveVariantId(address);
    Object.assign(manager.getAssetState(address).variants![id]!, {
      file,
      outputHash: file,
    });
    return id;
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-stranded-"));
    manager = await StateManager.init(tmp);
    accepted = take(VO, "vo-0.mp3");
    manager.setAccepted(VO, accepted);
    manager.setAccepted(FIT, take(FIT, "fit-0.mp3"));
    rival = take(VO, "vo-1.mp3");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const stranded = (jobs: JobRecord[], fit = true, echo = false, unplayed = false, spare = false) =>
    findStrandedTakes({
      manager,
      jobs,
      graph: buildDependencyGraph(null, animatic(fit, echo, unplayed, spare), null),
      animatic: animatic(fit, echo, unplayed, spare),
      video: null,
    });

  it("names an undecided take whose every dependent job built on it failed", () => {
    const failed = take(FIT, null);
    expect(stranded([job(failed, "failed", rival)])).toEqual([
      {
        address: VO,
        variantId: rival,
        accepted: true,
        failed: [
          {
            address: FIT,
            variantId: failed,
            error: "fitting a 1.64s take into 1.9s runs it at 0.862x",
          },
        ],
      },
    ]);
  });

  it("clears once a dependent job built on the take runs", () => {
    const failed = take(FIT, null);
    const retried = take(FIT, "fit-1.mp3");
    expect(stranded([job(failed, "failed", rival), job(retried, "completed", rival)])).toEqual([]);
    expect(stranded([job(failed, "failed", rival), job(retried, "pending", rival)])).toEqual([]);
  });

  it("reads a finished retry's inputs from its provenance", () => {
    const failed = take(FIT, null);
    const retried = job(take(FIT, "fit-1.mp3"), "completed", rival);
    Object.assign(retried, {
      metadata: {},
      provenance: {
        workflowHash: null,
        inputHash: null,
        resolvedDependencies: { [VO]: "vo-1.mp3" },
      },
    });
    expect(stranded([job(failed, "failed", rival), retried])).toEqual([]);
  });

  it("stands once the take a finished dependent made is dismissed", () => {
    const failed = take(FIT, null);
    const retried = take(FIT, "fit-1.mp3");
    manager.setDismissed(FIT, retried, true);
    expect(stranded([job(failed, "failed", rival), job(retried, "completed", rival)])).toHaveLength(
      1,
    );
  });

  it("leaves a failure built on another take alone", () => {
    expect(stranded([job(take(FIT, null), "failed", accepted)])).toEqual([]);
  });

  it("clears when another dependent built on the take runs", () => {
    const failed = take(FIT, null);
    const echoed = take("animatic:shot.01.voEcho", "echo-0.mp3");
    expect(
      stranded(
        [job(failed, "failed", rival), job(echoed, "completed", rival, "animatic:shot.01.voEcho")],
        true,
        true,
      ),
    ).toEqual([]);
  });

  it("stands when only a dependent no shot plays built on the take", () => {
    const failed = take(FIT, null);
    const spare = take("animatic:shot.01.voSpare", "spare-0.mp3");
    expect(
      stranded(
        [job(failed, "failed", rival), job(spare, "completed", rival, "animatic:shot.01.voSpare")],
        true,
        false,
        false,
        true,
      ),
    ).toHaveLength(1);
  });

  it("leaves an asset no shot plays alone", () => {
    expect(stranded([job(take(FIT, null), "failed", rival)], true, false, true)).toEqual([]);
  });

  it("clears when the shot plays the take itself", () => {
    expect(stranded([job(take(FIT, null), "failed", rival)], false)).toEqual([]);
  });

  it("clears once the take is dismissed", () => {
    const failed = take(FIT, null);
    manager.setDismissed(VO, rival, true);
    expect(stranded([job(failed, "failed", rival)])).toEqual([]);
  });
});
