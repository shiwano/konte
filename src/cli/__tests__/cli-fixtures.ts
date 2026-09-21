import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { parseAddressStream } from "../../core/address.js";
import { FeedbackManager } from "../../core/feedback/index.js";
import type { FeedbackEntry } from "../../core/types/index.js";
import { initWorkspace } from "./harness.js";
import { EMPTY_REFERENCE_TSX } from "./fixture-video.js";

export {
  acceptDirection,
  acceptFileAssets,
  doctorCheck,
  doctorChecks,
  initWorkspace,
  run,
  runCapture,
} from "./harness.js";
export { EMPTY_REFERENCE_TSX } from "./fixture-video.js";
export { writeSilentWav } from "../../core/__tests__/helpers/wav.js";

// Per-file temp workspace lifecycle. Each split cli-*.test.ts calls useTempWorkspace() once at
// module scope; the registered beforeEach/afterEach run before any describe-level hook, so ctx.dir
// is populated by the time an initWith* helper reads it. Each test file is its own vitest worker,
// so this module-level ctx is per-file — the reason the suite parallelizes across files at all.
export const ctx = { dir: "", originalCwd: "" };

export function useTempWorkspace(): void {
  beforeEach(async () => {
    ctx.originalCwd = process.cwd();
    ctx.dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-cli-test-"));
    process.chdir(ctx.dir);
  });
  afterEach(async () => {
    process.chdir(ctx.originalCwd);
    await fs.rm(ctx.dir, { recursive: true, force: true });
  });
}

export async function seedFeedback(
  videoRoot: string,
  address: string,
  entry: FeedbackEntry,
): Promise<void> {
  const { stage } = parseAddressStream(address);
  await FeedbackManager.withLock(videoRoot, stage, async (m) => {
    m.addFeedback(address, entry);
  });
}

export async function readFeedback(videoRoot: string, address: string): Promise<FeedbackEntry[]> {
  const { stage } = parseAddressStream(address);
  return (await FeedbackManager.load(videoRoot, stage)).getFeedback(address);
}

export const TEST_VIDEO_WITH_DEPS_TSX = `import { Composition, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const enhanceComfy = defineComfyAsset({
  workflow: "enhance.json",
  description: "test adapter",
  inputs: { source: { nodeId: "1", field: "video", type: "video" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      asset("final", enhanceComfy, { source: motion });
      return <Composition><div /></Composition>;
    }),
  }),
});
`;

// Two shots, the second built on the first's take (`shot("01")`), and both rendered. That split is
// what lets a consumer of `motion` be stale without the accepted shot's own build refusing over it
// (a shot's composition demands every asset of that shot be ready).
export const TEST_VIDEO_CHAINED_SHOTS_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, defineLens, asset, defineDirection } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  lenses: [defineLens({ name: "two-beat", payoff: "second", beats: [{ role: "first" }, { role: "second" }] })],
  sequence: {
    lens: "two-beat",
    pleasure: "cute",
    shots: [
      { id: "01", role: "first", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "second", action: "second shot", setup: "front", duration: 5 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const enhanceComfy = defineComfyAsset({
  workflow: "enhance.json",
  description: "test adapter",
  inputs: { source: { nodeId: "1", field: "video", type: "video" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      return <Composition><Video src={motion} /></Composition>;
    }).nextShot("02", ({ shot }) => {
      const enhanced = asset("enhanced", enhanceComfy, { source: shot("01").video("motion") });
      return <Composition><Video src={enhanced} /></Composition>;
    }),
  }),
});
`;

// A timeline asset (`bgm`) defined but referenced by no composition — an unused asset.
export const TEST_VIDEO_WITH_UNUSED_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => {
    asset("bgm", ttsComfy, { text: "music" });
    return { shots: shot("01", () => {
        const motion = asset("motion", animateComfy, { prompt: "test" });
        return <Composition><Video src={motion} /></Composition>;
      }) };
  },
});
`;

export const TEST_VIDEO_TSX = `import { Composition, Video, Audio, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      const voice = asset("voice", ttsComfy, { text: "hello" });
      return <Composition><Video src={motion} /><Audio src={voice} /></Composition>;
    }),
  }),
});
`;

// A board with no shots, carrying its own direction inline like TEST_VIDEO_TSX. animatic.tsx is a
// required entry, so a test that edits or deletes direction.ts needs a board that does not import
// it.
export const TEST_EMPTY_ANIMATIC_TSX = `import { defineAnimatic, defineDirection } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

export default defineAnimatic(direction, {
  timeline: () => ({ shots: [] }),
});
`;

// TEST_VIDEO_TSX plus a timeline soundtrack bed — the only thing that gives the video a
// `video:timeline#stem` leaf.
export const TEST_VIDEO_WITH_SOUNDTRACK_TSX = TEST_VIDEO_TSX.replace(
  "defineComfyAsset, defineVideo, asset,",
  "defineComfyAsset, defineVideo, asset, soundtrack,",
).replace(
  `  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      const voice = asset("voice", ttsComfy, { text: "hello" });
      return <Composition><Video src={motion} /><Audio src={voice} /></Composition>;
    }),
  }),`,
  `  timeline: ({ shot }) => {
    const bed = asset("bed", ttsComfy, { text: "bed" });
    return {
      shots: shot("01", () => {
        const motion = asset("motion", animateComfy, { prompt: "test" });
        const voice = asset("voice", ttsComfy, { text: "hello" });
        return <Composition><Video src={motion} /><Audio src={voice} /></Composition>;
      }),
      soundtracks: [soundtrack("bed", bed, { duck: false })],
    };
  },`,
);

// Shot 01 developed, shot 02 an undeveloped pendingShot — used to check that a profile whose
// developed shots are all accepted is still not reported "ready to export" while a shot is pending.
export const TEST_VIDEO_WITH_PENDING_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "hero", action: "later shot", setup: "detail", duration: 4 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      return <Composition><Video src={motion} /></Composition>;
    }).nextPendingShot("02"),
  }),
});
`;

// Animatic twin of TEST_VIDEO_WITH_PENDING_TSX: shot 01 develops a keyframe panel, shot 02 is an
// undeveloped pendingShot — used to check that an animatic whose developed panels are all accepted
// is still not reported "ready to export" while a shot is pending.
export const TEST_ANIMATIC_WITH_PENDING_TS = `import { defineComfyAsset, defineAnimatic, asset, defineDirection, Composition, Panel } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "hero", action: "later shot", setup: "detail", duration: 4 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => {
        const kf = asset("keyframe", imageComfy, { prompt: "a cat" });
        return <Composition>
<Panel src={kf} blocking="the cat rises to sit" camera="fixed" />
</Composition>;
      })
      .nextPendingShot("02") }),
});
`;

// Both shots undeveloped (pendingShot) — the whole video stage has no address. Used to check that
// the stage still shows its "N shots undeveloped" line in Progress instead of vanishing.
export const TEST_VIDEO_ALL_PENDING_TSX = `import { defineVideo, defineDirection } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "hero", action: "later shot", setup: "detail", duration: 4 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

export default defineVideo(direction, {
  timeline: ({ pendingShot }) => ({
    shots: pendingShot("01")
      .nextPendingShot("02"),
  }),
});
`;

// Composition-only definition with no AI/local backend assets, so `doctor`
// runs zero backend connectivity checks and the test makes no real network requests.
export const NO_BACKEND_VIDEO_TSX = `import { Composition, defineVideo, defineDirection } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => (
      <Composition>
        <div />
      </Composition>
    )),
  }),
});
`;

export async function writeWorkspaceConfig(videoDir: string, config: unknown): Promise<void> {
  const workspace = path.resolve(videoDir, "..", "..");
  await fs.writeFile(path.join(workspace, "konte.config.json"), JSON.stringify(config));
}

export async function initWithTestVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_TSX);
  return projectDir;
}

export async function initWithNoBackendVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), NO_BACKEND_VIDEO_TSX);
  // Empty the reference stage and swap the fixture board for an empty one — both declare backend
  // assets, and this helper exists to build a project that has none.
  await fs.writeFile(path.join(projectDir, "reference.tsx"), EMPTY_REFERENCE_TSX);
  await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_EMPTY_ANIMATIC_TSX);
  return projectDir;
}

export async function initWithDepsVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_DEPS_TSX);
  return projectDir;
}

export async function initWithChainedShotsVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_CHAINED_SHOTS_TSX);
  return projectDir;
}

export async function initWithUnusedVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_UNUSED_TSX);
  return projectDir;
}

export const TEST_CROSS_STAGE_ANIMATIC_TS = `import { defineComfyAsset, defineAnimatic, asset, defineDirection, Composition, Panel } from "konte";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => {
      const kf = asset("keyframe", imageComfy, { prompt: "a cat" });
      return <Composition>
<Panel src={kf} blocking="the cat rises to sit" camera="fixed" />
</Composition>;
    }) }),
});
`;

export const TEST_CROSS_STAGE_VIDEO_TSX = `import { Composition, Video, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";
import animatic from "./animatic";

const direction = defineDirection({
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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { image: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { image: animatic.shot("01").image("keyframe") });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

// The cross-stage fixture with its wiring cut: the video shot develops shot 01 and builds its motion
// from nothing on the board.
export const TEST_UNCONSUMED_ANIMATIC_VIDEO_TSX = TEST_CROSS_STAGE_VIDEO_TSX.replace(
  '{ image: animatic.shot("01").image("keyframe") }',
  "{}",
);

// A video whose picture is a TIMELINE asset on a vendor backend, drawn by a shot that consumes no
// board — the spend the wiring gate has to catch through an address that belongs to no shot.
export const TEST_TIMELINE_SPEND_VIDEO_TSX = TEST_CROSS_STAGE_VIDEO_TSX.replace(
  `  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { image: animatic.shot("01").image("keyframe") });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),`,
  `  timeline: ({ shot }) => {
    const bed = asset("bed", animateComfy, {});
    return { shots: shot("01", () => <Composition><Video src={bed} /></Composition>) };
  },`,
);

// A video shot the wiring gate exempts: its picture is a `local` take, so it spends on no vendor and
// has no input a board could be wired into. Reviewable, so a patch can be made against its take.
export const TEST_LOCAL_PICTURE_VIDEO_TSX = TEST_CROSS_STAGE_VIDEO_TSX.replace(
  `import { Composition, Video, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";`,
  `import { Composition, Image, Video, defineComfyAsset, defineVideo, asset, defineDirection } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";`,
).replace(
  `      const motion = asset("motion", animateComfy, { image: animatic.shot("01").image("keyframe") });
      return <Composition><Video src={motion} /></Composition>;`,
  `      const still = asset("still", internalTestImage, { width: 64, height: 64 });
      return <Composition><Image src={still} /></Composition>;`,
);

// The cross-stage fixture with sound on the board: the animatic shot plays a take, so konte derives
// `animatic:shot.01#stem`, and the video's motion is driven by it. What the plain cross-stage pair
// cannot show — the gate on a DETERMINISTIC upstream, whose accept is a human's and whose staleness
// is what must close it again.
export const TEST_CROSS_STAGE_STEM_ANIMATIC_TS = TEST_CROSS_STAGE_ANIMATIC_TS.replace(
  "defineAnimatic, asset, defineDirection, Composition, Panel }",
  "defineAnimatic, asset, defineDirection, Composition, Panel, Audio }",
)
  .replace(
    `const imageComfy = defineComfyAsset({`,
    `const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const imageComfy = defineComfyAsset({`,
  )
  .replace(
    `      const kf = asset("keyframe", imageComfy, { prompt: "a cat" });
      return <Composition>
<Panel src={kf} blocking="the cat rises to sit" camera="fixed" />
</Composition>;`,
    `      const kf = asset("keyframe", imageComfy, { prompt: "a cat" });
      const voice = asset("voice", ttsComfy, { text: "hello" });
      return <Composition>
<Panel src={kf} blocking="the cat rises to sit" camera="fixed" />
<Audio src={voice} />
</Composition>;`,
  );

export const TEST_CROSS_STAGE_STEM_VIDEO_TSX = TEST_CROSS_STAGE_VIDEO_TSX.replace(
  `  inputs: { image: { nodeId: "1", field: "image", type: "image" } },`,
  `  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    audio: { nodeId: "2", field: "audio", type: "audio" },
  },`,
).replace(
  `      const motion = asset("motion", animateComfy, { image: animatic.shot("01").image("keyframe") });`,
  `      const motion = asset("motion", animateComfy, {
        image: animatic.shot("01").image("keyframe"),
        audio: animatic.shot("01").stem,
      });`,
);

// direction.ts twin of the cross-stage fixture's inline direction, so the direction gates open and
// only the animatic gate is under test.
export const CROSS_STAGE_DIRECTION_TS = `import { defineDirection } from "konte";

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
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    waivers: {
      "location-unreferenced_studio": "fixture has no reference stage exposing it",
      "setup-unconsumed_front": "fixture board is anchored on nothing",
      "missing-beat_ordinary": "single-shot fixture",
      "missing-beat_disruption": "single-shot fixture",
      "missing-beat_pressure": "single-shot fixture",
      "unearned-payoff_hero": "single-shot fixture",
    },
  },
});
`;

export async function initWithCrossStageStemVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_CROSS_STAGE_STEM_ANIMATIC_TS);
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_CROSS_STAGE_STEM_VIDEO_TSX);
  return projectDir;
}

export async function initWithCrossStageVideo(): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const projectDir = inited.video;
  await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_CROSS_STAGE_ANIMATIC_TS);
  await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_CROSS_STAGE_VIDEO_TSX);
  return projectDir;
}
