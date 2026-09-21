import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobManager } from "../../../core/job-manager.js";
import { StateManager } from "../../../core/state/manager.js";
import { acceptDirection, initWorkspace, run } from "../../__tests__/harness.js";
import { EMPTY_REFERENCE_TSX } from "../../__tests__/fixture-video.js";

const DIRECTION_TS = `import { defineDirection, defineLens } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    detail: { name: "the detail", description: "in close on the hands", location: "studio", framing: "close", holds: ["studioMark"], within: null },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  // A fixture direction is one shot with no arc to check: no built-in lens declares a function-less
  // beat, so it brings its own container lens rather than staging a whole mini-drama.
  lenses: [defineLens({ name: "one-beat", payoff: "beat", beats: [{ role: "beat" }] })],
  sequence: {
    lens: "one-beat",
    pleasure: "cute",
    shots: [{ id: "01", role: "beat", action: "test shot", setup: "front", duration: 5 , lineup: [] }],
    // No reference stage in this fixture, so the sole location has no reference:studio to anchor on.
    // \`detail\` is here for the two-shot variant below, which swaps the shots line and nothing else.
    waivers: {
      "location-unreferenced_studio": "fixture has no reference stage",
      "unused-setup_detail": "declared for the two-shot variant of this fixture",
    },
  },
});
`;

// Two shots in the direction, the second still a pendingShot in the video stage.
const DIRECTION_WITH_PENDING_TS = DIRECTION_TS.replace(
  `shots: [{ id: "01", role: "beat", action: "test shot", setup: "front", duration: 5 , lineup: [] }],`,
  `shots: [
      { id: "01", role: "beat", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "beat", action: "later shot", setup: "detail", duration: 4 , lineup: [] },
    ],`,
);

// The board every fixture video develops. Its one panel is a `local` plate, so the board
// itself reaches no vendor backend, and each video below composites it — a video shot that spent
// on nothing from its own board is refused (ANIMATIC_UNCONSUMED).
const BOARD_ANIMATIC_TS = `import { defineAnimatic, adapters, asset, Composition, Panel } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  timeline: ({ format, shot }) =>
    ({ shots: shot("01", () => {
      const first = asset("first", internalTestPlate, {
        width: format.size.width,
        height: format.size.height,
        color: "#ffffff",
      });
      return <Composition>
<Panel src={first} blocking="the subject leans in" camera="fixed" />
</Composition>;
    }) }),
});
`;

const VIDEO_TSX = `import { Composition, Image, Video, defineComfyAsset, defineVideo, asset } from "konte";
import direction from "./direction";
import animatic from "./animatic";

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
      return <Composition><Video src={motion} /><Image src={animatic.shot("01").image("first")} /></Composition>;
    }),
  }),
});
`;

// A direction delivering well above its working canvas (1024×576 → 1920×1080), so an upscaler is
// owed. The delivery size lives here, not on the video.
const DIRECTION_WITH_DELIVERY_TS = DIRECTION_TS.replace(
  `size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } }`,
  `size: { megapixels: 0.589824, delivery: { width: 1920, height: 1080 } }`,
);

// A video that takes its canvas straight from the direction (so it picks up any delivery size), with no
// upscaler wired.
const VIDEO_FROM_DIRECTION_TSX = `import { Composition, Image, Video, defineComfyAsset, defineVideo, asset } from "konte";
import direction from "./direction";
import animatic from "./animatic";

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
      return <Composition><Video src={motion} /><Image src={animatic.shot("01").image("first")} /></Composition>;
    }),
  }),
});
`;

// The same, but wiring a frame upscaler.
const VIDEO_WITH_UPSCALE_TSX = `import { Composition, Image, Video, defineComfyAsset, defineVideo, asset, upscale } from "konte";
import direction from "./direction";
import animatic from "./animatic";

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const upscaleComfy = defineComfyAsset({
  workflow: "upscale.json",
  description: "test upscaler",
  inputs: {
    video: { nodeId: "1", type: "video" },
    width: { nodeId: "2", field: "value", type: "width" },
    height: { nodeId: "3", field: "value", type: "height" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  export: {
    delivery: {
      upscale: { frame: ({ video, width, height }) => upscale(upscaleComfy, { video, width, height }) },
    },
  },
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "test" });
      return <Composition><Video src={motion} /><Image src={animatic.shot("01").image("first")} /></Composition>;
    }),
  }),
});
`;

// Shot 01 developed, shot 02 undeveloped — a shot with no motion at all, which no flag overrides.
const VIDEO_WITH_PENDING_TSX = VIDEO_TSX.replace(
  `    }),
  }),
});`,
  `    }).nextPendingShot("02"),
  }),
});`,
);

const ANIMATIC_TS = `import { defineAnimatic, defineComfyAsset, asset, Composition, Panel } from "konte";
import direction from "./direction";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => {
      const first = asset("first", imageComfy, { prompt: "opening" });
      return <Composition>
<Panel src={first} blocking="the subject leans in" camera="fixed" />
</Composition>;
    }) }),
});
`;

// The composition composites an animatic panel — an out-of-shot ref that would render as a
// black layer if it resolved to nothing.
const VIDEO_WITH_ANIMATIC_REF_TSX = `import { Composition, Image, Video, defineComfyAsset, defineVideo, asset } from "konte";
import direction from "./direction";
import animatic from "./animatic";

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
      return (
        <Composition>
          <Video src={motion} />
          <Image src={animatic.shot("01").image("first")} />
        </Composition>
      );
    }),
  }),
});
`;

let tmpDir: string;
let originalCwd: string;
let projectDir: string;

// Scaffold a project, then replace its definitions with the fixture under test. The scaffold's
// reference stage is dropped and its board is the one above unless a fixture declares its own, so
// each test drives exactly the definition it describes.
async function initProject(files: {
  direction?: string;
  video: string;
  animatic?: string;
}): Promise<string> {
  const inited_testproject = await initWorkspace(path.join(tmpDir, "testproject"));
  const dir = inited_testproject.video;
  await fs.writeFile(path.join(dir, "direction.ts"), files.direction ?? DIRECTION_TS);
  await fs.writeFile(path.join(dir, "video.tsx"), files.video);
  await fs.writeFile(path.join(dir, "animatic.tsx"), files.animatic ?? BOARD_ANIMATIC_TS);
  await fs.writeFile(path.join(dir, "reference.tsx"), EMPTY_REFERENCE_TSX);
  return dir;
}

// The workspace config lives two levels above the video root (videos/<name>/).
async function writeConfig(videoDir: string, config: unknown): Promise<void> {
  await fs.writeFile(
    path.join(videoDir, "..", "..", "konte.config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

// The shape `export` gates on: an asset whose variant has a file, optionally accepted.
async function seedVariant(
  dir: string,
  address: string,
  { accepted }: { accepted: boolean },
): Promise<void> {
  const file = path.join(dir, "output", `${address.replace(/[@:.]/g, "_")}.mp4`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "media");

  const manager = await StateManager.load(dir);
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  if (accepted) manager.setAccepted(address, variantId);
  await manager.save();
}

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-export-test-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("export video", () => {
  it("refuses to spend before the direction is accepted", async () => {
    projectDir = await initProject({ video: VIDEO_TSX });

    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DIRECTION_ACCEPTANCE_REQUIRED"),
    });
  });

  it("blocks on unaccepted assets and names each one", async () => {
    projectDir = await initProject({ video: VIDEO_TSX });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: false });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("UNACCEPTED_ASSETS"),
    });
    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("video:shot.01.motion"),
    });

    // Nothing was spent: the gate throws before any export job is registered.
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("registers an export job for a fully accepted video", async () => {
    projectDir = await initProject({ video: VIDEO_TSX });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    const { stdout } = await run(["export", "video"], projectDir);
    const exportJobId = stdout.match(/Export job (\S+) registered \(video\)\./)?.[1];

    const jobs = await new JobManager(projectDir).listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: exportJobId,
      kind: "export",
      allowUnaccepted: false,
      noDelivery: false,
      outputDir: path.join("dist", "video"),
    });
  });

  it("renders the ready variants of an unaccepted video with --allow-unaccepted", async () => {
    projectDir = await initProject({ video: VIDEO_TSX });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: false });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    const { stdout } = await run(["export", "video", "--allow-unaccepted"], projectDir);
    const exportJobId = stdout.match(/Export job (\S+) registered \(video\)\./)?.[1];

    const jobs = await new JobManager(projectDir).listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: exportJobId, allowUnaccepted: true });
  });

  it("refuses to export an undeveloped shot — no flag overrides a pendingShot", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_PENDING_TS,
      video: VIDEO_WITH_PENDING_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    for (const args of [
      ["export", "video"],
      ["export", "video", "--allow-unaccepted"],
    ]) {
      await expect(run(args, projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("PENDING_SHOTS"),
      });
    }
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("refuses to export a composition ref that resolves to nothing", async () => {
    projectDir = await initProject({
      video: VIDEO_WITH_ANIMATIC_REF_TSX,
      animatic: ANIMATIC_TS,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    // animatic:shot.01.first — composited by the video, never generated.

    await expect(run(["export", "video", "--allow-unaccepted"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DEPENDENCY_NOT_RESOLVED"),
    });
  });

  it("rejects the reference stage, which has no deliverable", async () => {
    projectDir = await initProject({ video: VIDEO_TSX });
    await acceptDirection(projectDir);

    await expect(run(["export", "reference"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });

  it("rejects the animatic stage, a working stage with no deliverable", async () => {
    projectDir = await initProject({ video: VIDEO_TSX, animatic: ANIMATIC_TS });
    await acceptDirection(projectDir);

    await expect(run(["export", "animatic"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });
});

// The delivery pairing (size ↔ upscaler) and aspect are export-time concerns: a half-wired or
// aspect-mismatched delivery must NOT throw at video load (that would break read-only and
// reference-stage commands while the wiring is in progress), only when `konte export` actually
// produces the deliverable.
describe("export delivery gate", () => {
  it("errors when the direction declares a delivery size but the video wires no upscaler", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_FROM_DIRECTION_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DELIVERY_UPSCALE_REQUIRED"),
    });
    // Nothing spent: the gate throws before any export job is registered.
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("status does not call a video export-ready while its delivery upscaler is missing", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_FROM_DIRECTION_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("ready to export");
    expect(stdout).toContain("no delivery upscaler");
    expect(stdout).toContain("Wire export.delivery.upscale.video or .frame in video.tsx");
    expect(stdout).not.toContain("konte export video");
  });

  it("status calls the video export-ready once an upscaler is wired", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_WITH_UPSCALE_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    const { stdout } = await run(["status"], projectDir);
    expect(stdout).toContain("ready to export");
    expect(stdout).not.toContain("no delivery upscaler");
    expect(stdout).toContain("konte export video");
  });

  // Asserts registration only. That the render then skips the delivery path is `renderVideoToFile`'s
  // `noDelivery`, which no test here reaches — the render runs in the export worker.
  it("does not throw at load — --no-delivery registers the job with delivery skipped", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_FROM_DIRECTION_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    // The video loads (the pairing check never fires at definition time) and --no-delivery skips it.
    const { stdout } = await run(["export", "video", "--no-delivery"], projectDir);
    expect(stdout).toContain("Delivery skipped (--no-delivery)");
  });

  // The upscale is the one part of an export that spends, and a rough cut is not what it is spent
  // on — so --allow-unaccepted skips delivery without being asked, and submits no upscale job.
  it("skips delivery under --allow-unaccepted — a rough cut never reaches the upscales", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_WITH_UPSCALE_TSX,
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: false });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    const { stdout } = await run(["export", "video", "--allow-unaccepted"], projectDir);
    expect(stdout).toContain("Delivery skipped (--allow-unaccepted)");
    const exportJobId = stdout.match(/Export job (\S+) registered \(video\)\./)?.[1];

    const jobs = await new JobManager(projectDir).listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: exportJobId,
      kind: "export",
      allowUnaccepted: true,
      noDelivery: true,
      dependsOnJobs: [],
    });
  });

  // Export spends on a vendor backend, so it passes the same gate — before a delivery variant or
  // job exists.
  it("errors when the delivery upscaler runs on a backend this workspace has not configured", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_WITH_UPSCALE_TSX,
    });
    // `konte workspace new` ships a default comfyui.url, so the unconfigured state has to be written back.
    await writeConfig(projectDir, { comfyui: { url: "" } });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("comfyui.url"),
    });
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("errors when the delivery upscaler's ComfyUI credential is unset", async () => {
    projectDir = await initProject({
      direction: DIRECTION_WITH_DELIVERY_TS,
      video: VIDEO_WITH_UPSCALE_TSX,
    });
    await writeConfig(projectDir, {
      comfyui: {
        url: "http://127.0.0.1:8188",
        headers: { Authorization: "Bearer ${KONTE_TEST_EXPORT_TOKEN}" },
      },
    });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    await expect(run(["export", "video"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("KONTE_TEST_EXPORT_TOKEN"),
    });
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  // The working canvas is derived from the delivery's own aspect, so it lands a grid step off it
  // rather than on it — that gap is cropped at render, never upscaled, and owes no upscaler. Only a
  // real resolution increase does.
  it("demands no upscaler when the delivery is the canvas's own resolution", async () => {
    projectDir = await initProject({ direction: DIRECTION_TS, video: VIDEO_FROM_DIRECTION_TSX });
    await acceptDirection(projectDir);
    await seedVariant(projectDir, "video:shot.01.motion", { accepted: true });
    await seedVariant(projectDir, "animatic:shot.01.first", { accepted: true });

    await expect(run(["export", "video"], projectDir)).resolves.toBeDefined();
  });
});
