import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../../core/state/index.js";
import { keptViaMarker } from "../../../../core/staleness.js";
import { applyKeepDecisions, applyRegenerateDecisions } from "../review-shared.js";

// A board frame, a resize konte re-bakes from it, and the motion built on the resize.
const FRAME = "animatic:shot.01.first";
const SMALL = "animatic:shot.01.small";
const MOTION = "video:shot.01.motion";

let manager: StateManager;

beforeEach(async () => {
  manager = await StateManager.init(await fs.mkdtemp(path.join(tmpdir(), "konte-keep-")));
});

function accepted(address: string, fields: Record<string, unknown>): string {
  const variantId = manager.reserveVariantId(address);
  Object.assign(manager.getAssetState(address).variants![variantId]!, {
    file: `${variantId}.bin`,
    ...fields,
  });
  manager.setAccepted(address, variantId);
  return variantId;
}

describe("applyKeepDecisions through a re-made input", () => {
  const marker = keptViaMarker({ [FRAME]: "frame-new" });

  it("keeps the take against the upstream take its input is re-made from", () => {
    accepted(FRAME, { outputHash: "frame-new" });
    const motion = accepted(MOTION, { inputFingerprints: { [SMALL]: "small-old" } });

    expect(
      applyKeepDecisions(manager, [
        { address: MOTION, variantId: motion, inputs: { [SMALL]: marker } },
      ]),
    ).toEqual([MOTION]);
    expect(manager.getAssetState(MOTION).variants![motion]!.keptInputs).toEqual({
      [SMALL]: marker,
    });
  });

  it("keeps nothing once that upstream moved on from what the page saw", () => {
    accepted(FRAME, { outputHash: "frame-newer" });
    const motion = accepted(MOTION, { inputFingerprints: { [SMALL]: "small-old" } });

    expect(
      applyKeepDecisions(manager, [
        { address: MOTION, variantId: motion, inputs: { [SMALL]: marker } },
      ]),
    ).toEqual([]);
    expect(manager.getAssetState(MOTION).variants![motion]!.keptInputs).toBeUndefined();
  });
});

describe("applyRegenerateDecisions", () => {
  it("takes the accepted take off its accept and dismisses it, for generate to make again", () => {
    const motion = accepted(MOTION, {});

    expect(applyRegenerateDecisions(manager, [{ address: MOTION, variantId: motion }])).toEqual([
      MOTION,
    ]);
    expect(manager.getAcceptedVariant(MOTION)).toBeNull();
    expect(manager.getAssetState(MOTION).variants![motion]!.status).toBe("dismissed");
  });

  it("leaves a take that is no longer the accepted one", () => {
    const motion = accepted(MOTION, {});

    expect(applyRegenerateDecisions(manager, [{ address: MOTION, variantId: "v-other" }])).toEqual(
      [],
    );
    expect(manager.getAcceptedVariant(MOTION)).toBe(motion);
  });
});
