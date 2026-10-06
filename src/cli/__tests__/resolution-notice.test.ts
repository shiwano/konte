import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { StateManager } from "../../core/state/index.js";
import type { GenerationJob } from "../../core/types/index.js";
import { resolutionNotices, sweepNotices } from "../resolution-notice.js";

const ADDRESS = "video:shot.12.motion";

const currentTake = {
  stalenessCache: () => ({}),
  variantStaleness: () => ({ inputStale: false, definitionStale: false }),
} as unknown as StateManager;

function job(variantId: string, address: string, status: GenerationJob["status"]): GenerationJob {
  return { kind: "generation", id: variantId, variantId, address, status } as GenerationJob;
}

describe("resolutionNotices", () => {
  it("names the take still generating at the address and the job to wait on", () => {
    const notices = resolutionNotices(
      currentTake,
      { address: ADDRESS, variantId: "v-eI11yofR" },
      undefined,
      [job("v-ZKquO93Y", ADDRESS, "running")],
    );
    expect(notices).toEqual([
      `${ADDRESS}: v-ZKquO93Y still generating — this is the earlier take v-eI11yofR; \`konte job wait\` for the new one`,
    ]);
  });

  it("says nothing about a current take with no job at its address", () => {
    const notices = resolutionNotices(
      currentTake,
      { address: ADDRESS, variantId: "v-eI11yofR" },
      undefined,
      [job("v-other000", "video:shot.13.motion", "queued")],
    );
    expect(notices).toEqual([]);
  });
});

describe("sweepNotices", () => {
  it("folds a scope's generating addresses into one line naming every job to wait on", () => {
    const takes = [
      { address: "video:shot.01.motion", variantId: "v-old00001", scope: "video" },
      { address: "video:shot.02.motion", variantId: "v-old00002", scope: "video" },
      { address: "video:shot.03.motion", variantId: "v-old00003", scope: "video" },
    ];
    const notices = sweepNotices(currentTake, "video", takes, undefined, [
      job("v-new00001", "video:shot.01.motion", "running"),
      job("v-new00002", "video:shot.02.motion", "pending"),
    ]);
    expect(notices).toEqual([
      "video: v-new00001, v-new00002 still generating — the earlier takes are shown; `konte job wait` for the new ones",
    ]);
  });

  it("counts a scope's stale takes on one line", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-resolution-notice-"));
    try {
      const manager = await StateManager.init(tmpDir);
      for (const shot of ["01", "02"]) {
        manager.ensureAssetState(`video:shot.${shot}.motion`).variants = {
          [`v-old000${shot}`]: {
            status: "none",
            file: `${shot}.mp4`,
            definitionHash: "EDITED",
            outputHash: shot,
            createdAt: "2026-01-01T00:00:01.000Z",
            readyAt: "2026-01-01T00:00:01.000Z",
            inputFingerprints: {},
            metadata: {},
          },
        };
      }
      manager.useResolutionDefinitions({
        definitionHash: () => "CURRENT",
        isDeterministic: () => false,
      });
      const takes = [
        { address: "video:shot.01.motion", variantId: "v-old00001", scope: "video" },
        { address: "video:shot.02.motion", variantId: "v-old00002", scope: "video" },
      ];
      expect(sweepNotices(manager, "video", takes, undefined, [])).toEqual([
        "video: 2 stale take(s) shown — `konte inspect video` lists them",
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
