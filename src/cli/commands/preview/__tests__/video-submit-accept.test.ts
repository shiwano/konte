import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleReelSubmit } from "../reel-review.js";
import { reloadVideoDefinition } from "../../../../core/loader.js";
import { StateManager } from "../../../../core/state/index.js";
import { ctx, initWorkspace, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "she opens the door", setup: "front", duration: 5 },
      { id: "02", role: "beat", action: "she steps through", setup: "front", duration: 5 },
    ],
  },
});
`;

const ANIMATIC_TS = `import { defineAnimatic, defineComfyAsset, asset, Composition, Panel } from "konte";
import direction from "./direction";

const frameComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => <Composition>
<Panel src={asset("frame", frameComfy, { prompt: "the door" })} />
</Composition>)
      .nextShot("02", () => <Composition>
<Panel src={asset("frame", frameComfy, { prompt: "through it" })} />
</Composition>) }),
});
`;

// Two shots, both with a motion asset. The test generates a take for 01 only, leaving 02's motion
// with no variant — the shape that used to make the submit path's render plan throw.
const VIDEO_TSX = `import { Composition, Video, defineVideo, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "she opens the door" });
      return <Composition><Video src={motion} /></Composition>;
    }).nextShot("02", () => {
      const motion = asset("motion", animate, { prompt: "she steps through" });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

// Shot 01 additionally carries an <Audio> cue whose asset is never generated. Neither leaf the shot
// accept promises can be materialized against it — the stem refuses on the unresolved ref, and the
// composition's own build renders the same cue — so accepting this shot lands nothing.
const VIDEO_WITH_UNREADY_AUDIO_TSX = `import { Audio, Composition, Video, defineVideo, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const tts = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "1", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "she opens the door" });
      const vo = asset("vo", tts, { text: "here we go" });
      return <Composition><Video src={motion} /><Audio src={vo} /></Composition>;
    }).nextShot("02", () => {
      const motion = asset("motion", animate, { prompt: "she steps through" });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

// Shot 02 is an undeveloped shot. A decision on it settles nothing, so it must not be written down
// as an outcome — nor carried into the direction.
const VIDEO_PENDING_02_TSX = `import { Composition, Video, defineVideo, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "she opens the door" });
      return <Composition><Video src={motion} /></Composition>;
    }).nextPendingShot("02"),
  }),
});
`;

const SHOT_01_MOTION = "video:shot.01.motion";

async function project(videoTsx = VIDEO_TSX): Promise<{ videoRoot: string; variantId: string }> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), ANIMATIC_TS);
  await fs.writeFile(path.join(videoRoot, "video.tsx"), videoTsx);

  const sm = await StateManager.load(videoRoot);
  const variantId = sm.reserveVariantId(SHOT_01_MOTION);
  sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.file = "assets/motion.mp4";
  await sm.save();
  return { videoRoot, variantId };
}

async function submit(
  videoRoot: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; payload: Record<string, unknown> }> {
  const videoPath = path.join(videoRoot, "video.tsx");
  const defs = await loadPreviewDefinitions({ videoRoot, videoPath, mode: "video-preview" });
  const res = await handleReelSubmit(
    videoRoot,
    () => reloadVideoDefinition(videoPath),
    null,
    defs.direction,
    defs.animatic,
    new Request("http://127.0.0.1/api/video/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, payload: (await res.json()) as Record<string, unknown> };
}

// The regression: the submit path built its render plan under stricter options than the page did,
// so a video with any not-ready asset (a shot still on its animatic, an unmade BGM) threw there.
// The throw was caught into a null plan, the whole accept block was skipped, and the review was
// still written down as fully accepted and answered 200 — so every accept vanished and the next
// review asked for all of them again.
describe("handleReelSubmit — accepts land while another shot is not ready", () => {
  it("accepts the shot the reviewer signed off, though a sibling shot has no take yet", async () => {
    const { videoRoot, variantId } = await project();

    const { res } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });
    expect(res.status).toBe(200);

    const sm = await StateManager.load(videoRoot);
    // The generated take…
    expect(sm.getAcceptedVariant(SHOT_01_MOTION)).toBe(variantId);
    // …and the composition the shot accept materializes as its re-review baseline. Without this
    // one, the next review reads the shot as never signed off — exactly what was reported.
    expect(sm.getAcceptedVariant("video:shot.01#composition")).not.toBeNull();
    // The undecided sibling is untouched, not swept along.
    expect(sm.getAcceptedVariant("video:shot.02.motion")).toBeNull();
  });

  it("writes a record whose accepted shots are backed by state", async () => {
    const { videoRoot, variantId } = await project();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });

    const filePath = payload.filePath as string;
    expect(filePath).toBeTruthy();
    const record = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      decisions: Record<string, string>;
      skippedDecisions?: unknown[];
      context: { shots: unknown[]; timeline?: unknown };
    };

    // Nothing was skipped, so the record claims exactly what landed.
    expect(record.skippedDecisions).toBeUndefined();
    expect(record.decisions["01"]).toBe("accepted");
    const sm = await StateManager.load(videoRoot);
    for (const shotId of Object.keys(record.decisions)) {
      if (record.decisions[shotId] !== "accepted") continue;
      expect(sm.getAcceptedVariant(`video:shot.${shotId}#composition`)).not.toBeNull();
    }

    // The plan-was-null fingerprint the lost reviews left behind: an empty shot list and no
    // `timeline` key at all. A record shaped like that means the accepts never ran.
    expect(record.context.shots).not.toHaveLength(0);
    expect(record.context.timeline).toBeDefined();
  });

  it("releases an accept on 'none' even while a sibling shot is not ready", async () => {
    const { videoRoot, variantId } = await project();

    await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(SHOT_01_MOTION)).toBe(variantId);

    const { res } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "none" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });
    expect(res.status).toBe(200);
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(SHOT_01_MOTION)).toBeNull();
  });
});

// The second half of the guarantee: a submit must never write down an accept that state does not
// back. The accept blocks swallow per-item failures by design, so the handler re-reads state and
// asks the review page's own question — does this leaf still need review? — before recording
// anything.
describe("handleReelSubmit — an accept that cannot land is reported, not recorded", () => {
  it("names every leaf of a shot accept that did not land, picture and audio alike", async () => {
    const { videoRoot, variantId } = await project(VIDEO_WITH_UNREADY_AUDIO_TSX);

    const { res, payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });
    expect(res.status).toBe(200);

    // A shot accept promises its picture AND its audio; both are checked, so a half-landed accept
    // cannot pass as a whole one.
    const skipped = payload.skippedDecisions as Array<{ shotId: string; address: string }>;
    expect(skipped.map((s) => s.address).sort()).toEqual([
      "video:shot.01#composition",
      "video:shot.01#stem",
    ]);

    // The shot is NOT written down as accepted, so the next review asks for it again.
    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      decisions: Record<string, string>;
      skippedDecisions?: unknown[];
    };
    expect(record.decisions["01"]).toBeUndefined();
    expect(record.skippedDecisions).toHaveLength(2);

    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant("video:shot.01#composition")).toBeNull();
    expect(sm.getAcceptedVariant("video:shot.01#stem")).toBeNull();
  });

  it("persists the record when a skip is the review's only outcome", async () => {
    const { videoRoot } = await project(VIDEO_WITH_UNREADY_AUDIO_TSX);

    // No `displayedVariants`, so not even the per-asset accepts land: nothing is accepted, nothing
    // released, no notes. Without forcing on the skip, a video record with no notes is treated as
    // empty and never written — the skip would exist only as a terminal line.
    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedStandInShotIds: [],
    });

    expect(payload.acceptedAssets).toEqual([]);
    expect(payload.unacceptedAssets).toEqual([]);
    expect(payload.skippedDecisions).toHaveLength(2);
    expect(payload.saved).toBe(true);
    expect(payload.filePath).toBeTruthy();
  });

  it("does not record a decision for a shot the plan does not have", async () => {
    const { videoRoot, variantId } = await project();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      // "99" was renamed or deleted from video.tsx while the review was open. It is applied to
      // nothing, so it must not be recorded as an outcome either.
      decisions: { "01": "accepted", "99": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });

    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      decisions: Record<string, string>;
    };
    expect(record.decisions).toEqual({ "01": "accepted" });
  });
});

// A verdict on an undeveloped shot settles nothing. The UI will not mint one, but a source reload
// can turn a shot the reviewer already judged into a pendingShot — and a decision left in the record
// then claims an outcome state does not back, the same class as the bug this file exists for.
describe("handleReelSubmit — a decision on an undeveloped shot is not an outcome", () => {
  it("drops it from the record instead of recording it as accepted", async () => {
    const { videoRoot, variantId } = await project(VIDEO_PENDING_02_TSX);

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted", "02": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });

    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      decisions: Record<string, string>;
      cascadeAccepted?: Array<{ address: string; via: string }>;
    };
    expect(record.decisions).toEqual({ "01": "accepted" });
    // Nothing failed — the shot simply has nothing to sign off — so it is not reported as a skip.
    expect(payload.skippedDecisions).toEqual([]);
    // …and it must not have settled any direction part on the strength of that decision.
    expect((record.cascadeAccepted ?? []).some((c) => c.via === "video:shot.02")).toBe(false);
  });

  it("drops a 'none' on an undeveloped shot the same way", async () => {
    const { videoRoot, variantId } = await project(VIDEO_PENDING_02_TSX);

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted", "02": "none" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });

    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      decisions: Record<string, string>;
    };
    expect(record.decisions).toEqual({ "01": "accepted" });
  });
});

// A shot standing in with its board frame has nothing on screen to judge, so a verdict on one must
// not reach the delivered side — the composition it would sign off is one nobody watched.
describe("handleReelSubmit — a verdict on a board-frame stand-in is dropped", () => {
  it("lands no accept and records no decision for it", async () => {
    const { videoRoot, variantId } = await project();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: ["01"],
    });

    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(SHOT_01_MOTION)).toBeNull();
    expect(sm.getAcceptedVariant("video:shot.01#composition")).toBeNull();

    // The only decision was dropped, so the review has no outcome to write down — and nothing
    // failed, so it is not reported as a skip either.
    expect(payload.acceptedAssets).toEqual([]);
    expect(payload.filePath).toBeNull();
    expect(payload.skippedDecisions).toEqual([]);
  });

  it("leaves a standing accept alone on 'none'", async () => {
    const { videoRoot, variantId } = await project();

    await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "accepted" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
    });
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(SHOT_01_MOTION)).toBe(variantId);

    await submit(videoRoot, {
      stage: "video",
      decisions: { "01": "none" },
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: ["01"],
    });
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(SHOT_01_MOTION)).toBe(variantId);
  });
});

describe("handleReelSubmit — the record names the take each note was written against", () => {
  it("stamps a note with its subject's displayed variants", async () => {
    const { videoRoot, variantId } = await project();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: {},
      displayedVariants: { [SHOT_01_MOTION]: variantId },
      displayedStandInShotIds: [],
      addedFeedback: [{ address: "video:shot.01", text: "too dark", annotation: null, time: 1.5 }],
      notes: [{ time: 1.5, shotId: "01", address: "video:shot.01", text: "too dark" }],
    });

    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      notes: Array<{ id?: string; displayedVariants?: Record<string, string> }>;
    };
    expect(record.notes[0]!.id).toMatch(/^fb-/);
    expect(record.notes[0]!.displayedVariants).toMatchObject({ [SHOT_01_MOTION]: variantId });
  });
});

describe("handleReelSubmit — keep or regenerate", () => {
  const FRAME = "animatic:shot.01.frame";

  // Shot 01's accepted motion was made from a board frame the board has since moved past.
  async function upstreamMoved(): Promise<{ videoRoot: string; variantId: string }> {
    const { videoRoot, variantId } = await project();
    const sm = await StateManager.load(videoRoot);
    const frame = sm.reserveVariantId(FRAME);
    Object.assign(sm.getAssetState(FRAME).variants![frame]!, {
      file: "assets/frame.png",
      outputHash: "frame-new",
    });
    sm.setAccepted(FRAME, frame);
    sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.inputFingerprints = {
      [FRAME]: "frame-old",
    };
    sm.setAccepted(SHOT_01_MOTION, variantId);
    await sm.save();
    return { videoRoot, variantId };
  }

  it("keeps a take a Keep names against the upstream it resolves to now", async () => {
    const { videoRoot, variantId } = await upstreamMoved();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: {},
      keep: [{ address: SHOT_01_MOTION, variantId, inputs: { [FRAME]: "frame-new" } }],
      displayedStandInShotIds: [],
    });
    expect(payload.kept).toEqual([SHOT_01_MOTION]);

    const sm = await StateManager.load(videoRoot);
    expect(sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.keptInputs).toEqual({
      [FRAME]: "frame-new",
    });
    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      kept?: string[];
    };
    expect(record.kept).toEqual([SHOT_01_MOTION]);
  });

  it("keeps nothing against an upstream that moved since the page read it", async () => {
    const { videoRoot, variantId } = await upstreamMoved();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: {},
      keep: [{ address: SHOT_01_MOTION, variantId, inputs: { [FRAME]: "frame-between" } }],
      displayedStandInShotIds: [],
    });
    expect(payload.kept).toEqual([]);

    const sm = await StateManager.load(videoRoot);
    expect(sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.keptInputs).toBeUndefined();
  });

  it("keeps nothing for a take that is no longer the accepted one", async () => {
    const { videoRoot } = await upstreamMoved();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: {},
      keep: [{ address: SHOT_01_MOTION, variantId: "v-gone", inputs: { [FRAME]: "frame-new" } }],
      displayedStandInShotIds: [],
    });
    expect(payload.kept).toEqual([]);
  });

  it("dismisses the take a Regenerate names, keeping nothing", async () => {
    const { videoRoot, variantId } = await upstreamMoved();

    const { payload } = await submit(videoRoot, {
      stage: "video",
      decisions: {},
      keep: [{ address: SHOT_01_MOTION, variantId, inputs: { [FRAME]: "frame-new" } }],
      regenerate: [{ address: SHOT_01_MOTION, variantId }],
      displayedStandInShotIds: [],
    });
    expect(payload.kept).toEqual([]);
    expect(payload.regenerate).toEqual([SHOT_01_MOTION]);

    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(SHOT_01_MOTION)).toBeNull();
    expect(sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.status).toBe("dismissed");
    expect(sm.getAssetState(SHOT_01_MOTION).variants![variantId]!.keptInputs).toBeUndefined();
    const record = JSON.parse(await fs.readFile(payload.filePath as string, "utf-8")) as {
      regenerate?: string[];
    };
    expect(record.regenerate).toEqual([SHOT_01_MOTION]);
  });
});
