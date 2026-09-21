import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleGetReelState, handleReelSubmit } from "../reel-review.js";
import { reloadVideoDefinition } from "../../../../core/loader.js";
import { StateManager } from "../../../../core/state/index.js";
import {
  ctx,
  initWorkspace,
  readFeedback,
  useTempWorkspace,
} from "../../../__tests__/cli-fixtures.js";

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
    ],
  },
});
`;

const ANIMATIC_TS = `import { defineAnimatic, defineComfyAsset, asset, Composition, Panel } from "konte";
import direction from "./direction";

const frame = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => <Composition>
<Panel src={asset("frame", frame, { prompt: "the door" })} />
</Composition>) }),
});
`;

// One shot carrying both halves: a picture take and an <Audio> cue. The cue is the medium the page
// keeps on its own track, and the one a client-built subject dropped.
const VIDEO_TSX = `import { Audio, Composition, Image, Video, defineVideo, defineComfyAsset, asset } from "konte";
import direction from "./direction";
import animatic from "./animatic";

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
      return <Composition><Image src={animatic.shot("01").image("frame")} /><Video src={motion} /><Audio src={vo} /></Composition>;
    }),
  }),
});
`;

// The same shot with its audio removed — what the definition looks like after the edit a review can
// straddle.
const VIDEO_NO_AUDIO_TSX = VIDEO_TSX.replace(
  `      const vo = asset("vo", tts, { text: "here we go" });\n`,
  "",
).replace("<Audio src={vo} />", "");

// The shot undeveloped: no `shotFn`, so the composition leaf the page was showing is gone too.
const VIDEO_PENDING_TSX = `import { defineVideo } from "konte";
import direction from "./direction";

export default defineVideo(direction, {
  timeline: ({ pendingShot }) => ({ shots: pendingShot("01") }),
});
`;

const SHOT = "video:shot.01";
const MOTION = "video:shot.01.motion";
const VO = "video:shot.01.vo";
const PANEL = "animatic:shot.01.frame";
const COMPOSITION = "video:shot.01#composition";
const STEM = "video:shot.01#stem";

async function project(videoTsx = VIDEO_TSX): Promise<{
  videoRoot: string;
  motionId: string;
  voId: string;
  panelId: string;
}> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), ANIMATIC_TS);
  await fs.writeFile(path.join(videoRoot, "video.tsx"), videoTsx);

  const sm = await StateManager.load(videoRoot);
  const take = (address: string, file: string): string => {
    const id = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![id]!.file = file;
    return id;
  };
  const motionId = take(MOTION, "assets/motion.mp4");
  const voId = take(VO, "assets/vo.wav");
  const panelId = take(PANEL, "assets/frame.png");
  await sm.save();
  return { videoRoot, motionId, voId, panelId };
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

// The bug this covers end to end: a comment on a shot saved with only the picture in its subject, so
// a reroll of the line it was written about left it reading as still standing.
describe("handleReelSubmit — the subject a comment is persisted with", () => {
  it("carries the shot's audio take as well as its picture", async () => {
    const { videoRoot, motionId, voId, panelId } = await project();

    const { res } = await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "the line sounds too crisp", annotation: null }],
      displayedVariants: { [MOTION]: motionId, [VO]: voId, [PANEL]: panelId },
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      displayedStandInShotIds: [],
    });
    expect(res.status).toBe(200);

    const [entry] = await readFeedback(videoRoot, SHOT);
    // The board frame the composite draws counts as much as the shot's own two: it is on screen.
    expect(entry?.displayedVariants).toEqual({
      [MOTION]: motionId,
      [VO]: voId,
      [PANEL]: panelId,
    });
    expect(entry?.displayedDefinitionHashes).toEqual({ [COMPOSITION]: "c1", [STEM]: "s1" });
  });

  // The other half of that: the page can only report a take it was told about, and a board panel or
  // a reference sheet is in none of its own asset arrays. Without this map the subject named the
  // address and the submit dropped it for want of a value.
  it("is told by the GET which take each composition ref was drawn from", async () => {
    const { videoRoot, panelId } = await project();
    const videoPath = path.join(videoRoot, "video.tsx");
    const defs = await loadPreviewDefinitions({ videoRoot, videoPath, mode: "video-preview" });
    const res = await handleGetReelState(
      videoRoot,
      defs.video!,
      "http://127.0.0.1/assets",
      null,
      defs.direction,
      defs.animatic,
      defs.reference,
    );
    const state = (await res.json()) as { compositionRefVariants: Record<string, string> };
    expect(state.compositionRefVariants[PANEL]).toBe(panelId);
  });

  // The preview renders a stem live from the definition, so its accepted take is not what played.
  it("never carries a stem's own take", async () => {
    const { videoRoot, motionId, voId } = await project();

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "note", annotation: null }],
      // A page that reported a take for the stem anyway must not get it written down.
      displayedVariants: { [MOTION]: motionId, [VO]: voId, [STEM]: "v-stem" },
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      displayedStandInShotIds: [],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    expect(Object.keys(entry?.displayedVariants ?? {})).not.toContain(STEM);
  });

  it("takes the take the page says it displayed, not the one state resolves now", async () => {
    const { videoRoot, motionId } = await project();
    // The gallery pick: a take the reviewer switched to, which resolution would not have chosen.
    const sm = await StateManager.load(videoRoot);
    const picked = sm.reserveVariantId(VO);
    sm.getAssetState(VO).variants![picked]!.file = "assets/vo-2.wav";
    await sm.save();

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "note", annotation: null }],
      displayedVariants: { [MOTION]: motionId, [VO]: picked },
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      displayedStandInShotIds: [],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    expect(entry?.displayedVariants?.[VO]).toBe(picked);
  });

  // The definition moved between the page loading and this submit, so what the reviewer perceived at
  // that leaf is not knowable. Recorded as null — which reads `unknown`, not `fresh`.
  it("records a null for a leaf the page reported no hash for", async () => {
    const { videoRoot, motionId, voId } = await project();

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "note", annotation: null }],
      displayedVariants: { [MOTION]: motionId, [VO]: voId },
      // The page was served before the shot had any audio, so it carries no stem hash.
      displayedDefinitionHashes: { [COMPOSITION]: "c1" },
      displayedStandInShotIds: [],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    expect(entry?.displayedDefinitionHashes).toEqual({ [COMPOSITION]: "c1", [STEM]: null });
  });

  // The mirror of the null sentinel: a leaf the page WAS showing that the definition no longer
  // derives. Dropping the hash would leave the comment reading fresh against a shot that has lost
  // half of itself; keeping it makes the missing current value read stale.
  it("keeps the hash of a leaf the definition no longer holds", async () => {
    const { videoRoot, motionId, panelId } = await project(VIDEO_NO_AUDIO_TSX);

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "note", annotation: null }],
      displayedVariants: { [MOTION]: motionId, [PANEL]: panelId },
      // The page was served while the shot still sounded something.
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      displayedStandInShotIds: [],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    expect(entry?.displayedDefinitionHashes).toEqual({ [COMPOSITION]: "c1", [STEM]: "s1" });
  });

  // A video shot showing the board draws the ANIMATIC's shot, not its own. Reading the subject off
  // the video definition there named assets nobody saw — and on a shot whose picture is not made
  // yet, named nothing at all.
  it("stands a stand-in shot's comment against the board it is showing", async () => {
    const { videoRoot, motionId, voId, panelId } = await project();

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "the pose reads wrong", annotation: null }],
      displayedVariants: { [MOTION]: motionId, [VO]: voId, [PANEL]: panelId },
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      // The page reported it drew the board here.
      displayedStandInShotIds: ["01"],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    // The board's frame, not the video shot's own takes — those were not on screen.
    expect(entry?.displayedVariants).toEqual({ [PANEL]: panelId });
    // And not the video shot's leaves, whose definitions this comment says nothing about — an empty
    // map is stored as no map at all.
    expect(entry?.displayedDefinitionHashes).toBeUndefined();
  });

  it("keeps the hash of a composition leaf the definition no longer holds", async () => {
    const { videoRoot } = await project(VIDEO_PENDING_TSX);

    await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: SHOT, text: "note", annotation: null }],
      displayedVariants: {},
      // The page was served while the shot was still developed.
      displayedDefinitionHashes: { [COMPOSITION]: "c1", [STEM]: "s1" },
      displayedStandInShotIds: [],
    });

    const [entry] = await readFeedback(videoRoot, SHOT);
    expect(entry?.displayedDefinitionHashes).toEqual({ [COMPOSITION]: "c1", [STEM]: "s1" });
  });

  // A comment with no derivable subject saves as one nothing can ever contradict, so the submit is
  // refused outright rather than writing one down.
  it("refuses a comment on a target this stage does not hold", async () => {
    const { videoRoot, motionId } = await project();

    const { res } = await submit(videoRoot, {
      stage: "video",
      addedFeedback: [{ address: "video:shot.99", text: "note", annotation: null }],
      // Submitted beside a real accept: the check has to run ahead of it, or the review lands
      // half-applied — the shot signed off, the comment refused.
      decisions: { "01": "accepted" },
      displayedVariants: { [MOTION]: motionId },
      displayedStandInShotIds: [],
    });
    expect(res.status).toBe(400);

    // Nothing landed: not the comment, and not the accept it was submitted beside.
    expect(await readFeedback(videoRoot, "video:shot.99")).toEqual([]);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(MOTION)).toBeNull();
  });
});
