import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  acceptDirection,
  doctorCheck,
  useTempWorkspace,
  initWithNoBackendVideo,
  initWithUnusedVideo,
  run,
  runCapture,
  writeWorkspaceConfig,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("doctor command (orphaned targets)", () => {
  let projectDir: string;

  beforeEach(async () => {
    // No backend assets, so doctor skips all connectivity checks (no real network).
    projectDir = await initWithNoBackendVideo();
  });

  it("warns about orphaned targets", async () => {
    const sm = await StateManager.load(projectDir);
    const orphan = "video:shot.99.old";
    const v = sm.reserveVariantId(orphan);
    sm.setAccepted(orphan, v);
    await sm.save();

    const check = await doctorCheck(projectDir, "orphaned targets");

    expect(check?.status).toBe("WARN");
    expect(check?.message).toContain(orphan);
    expect(check?.message).toContain("konte prune");
  });

  it("does not flag a live accepted composition as orphaned", async () => {
    // shot.01 has a shotFn → video:shot.01#composition is a live re-review baseline,
    // not an orphan. doctor must not warn.
    const compAddress = "video:shot.01#composition";
    const sm = await StateManager.load(projectDir);
    const compVid = sm.reserveVariantId(compAddress);
    sm.setAccepted(compAddress, compVid);
    await sm.save();

    expect((await doctorCheck(projectDir, "orphaned targets"))?.status).toBe("PASS");
  });

  it("exits non-zero when a check fails", async () => {
    await fs.writeFile(path.join(projectDir, "konte.state.json"), "{ not valid json");

    const err = await run(["doctor"], projectDir).then(
      () => null,
      (e: { code?: number; stdout?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(1);
    expect(err?.stdout).toContain("✗ FAIL");
  });
});

describe("doctor command (stale assets)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithNoBackendVideo();
  });

  it("does not flag an asset whose only stale variant is a non-accepted history one", async () => {
    // Repro of the status/doctor truth mismatch: the accepted variant is healthy, but an older
    // rejected variant consumed the upstream at a now-stale hash. status reports "all accepted",
    // so doctor must not contradict it by warning on the harmless history variant.
    const sm = await StateManager.load(projectDir);

    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);

    const motion = "video:shot.01.motion";
    const healthy = sm.reserveVariantId(motion);
    sm.getAssetState(motion).variants![healthy]!.file = "/tmp/healthy.mp4";
    sm.getAssetState(motion).variants![healthy]!.inputFingerprints = {
      "video:shot.01.first": "up-current",
    };
    sm.setAccepted(motion, healthy);

    const oldVariant = sm.reserveVariantId(motion);
    sm.getAssetState(motion).variants![oldVariant]!.file = "/tmp/old.mp4";
    sm.getAssetState(motion).variants![oldVariant]!.inputFingerprints = {
      "video:shot.01.first": "up-old",
    };
    await sm.save();

    const check = await doctorCheck(projectDir, "stale assets");

    expect(check?.status).toBe("PASS");
    expect(check?.message).not.toContain(motion);
  });

  it("warns when the accepted variant itself is stale", async () => {
    const sm = await StateManager.load(projectDir);

    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);

    const motion = "video:shot.01.motion";
    const stale = sm.reserveVariantId(motion);
    sm.getAssetState(motion).variants![stale]!.file = "/tmp/stale.mp4";
    sm.getAssetState(motion).variants![stale]!.inputFingerprints = {
      "video:shot.01.first": "up-old",
    };
    sm.setAccepted(motion, stale);
    await sm.save();

    const check = await doctorCheck(projectDir, "stale assets");

    expect(check?.status).toBe("WARN");
    expect(check?.message).toContain(motion);
  });
});

describe("doctor command (unused assets)", () => {
  it("warns about an asset no composition or panel uses", async () => {
    const projectDir = await initWithUnusedVideo();
    const check = await doctorCheck(projectDir, "unused assets");
    expect(check?.status).toBe("WARN");
    expect(check?.message).toContain("timeline.bgm");
  });
});

describe("doctor command (configured backends)", () => {
  const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", description: "a mark only this place has" } } } },
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
`;

  function videoWithAsset(imports: string, declaration: string): string {
    return `import { Composition, Image, asset, defineVideo, ${imports} } from "konte";
import direction from "./direction";

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const image = ${declaration};
      return <Composition><Image src={image} /></Composition>;
    }),
  }),
});
`;
  }

  // A workspace with no ComfyUI URL: comfy is unconfigured, so a comfy asset has no backend to
  // run on.
  async function initWithPolicyVideo(videoTsx: string): Promise<string> {
    const projectDir = await initWithNoBackendVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), videoTsx);
    await writeWorkspaceConfig(projectDir, {});
    return projectDir;
  }

  async function backendCheck(projectDir: string) {
    return doctorCheck(projectDir, "configured backends");
  }

  it("fails on an asset whose backend this workspace has not configured", async () => {
    const projectDir = await initWithPolicyVideo(
      videoWithAsset(
        "defineComfyAsset",
        `asset("still", defineComfyAsset({
        workflow: "image.json",
        description: "test adapter",
        inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
        outputs: { result: { nodeId: "9", type: "image" } },
      }), { prompt: "cat" })`,
      ),
    );

    const check = await backendCheck(projectDir);
    expect(check?.status).toBe("FAIL");
    expect(check?.details).toEqual(["video:shot.01.still (comfy)"]);
    expect(check?.message).toContain("comfyui.url");
  });

  it("warns while no vendor backend is configured at all", async () => {
    const projectDir = await initWithPolicyVideo(
      videoWithAsset(
        "adapters",
        `asset("canvas", adapters.jsxImage, { width: 1920, height: 1080 })`,
      ),
    );

    const check = await backendCheck(projectDir);
    expect(check?.status).toBe("WARN");
    // A `local` asset needs no vendor, so it is not what the warning is about.
    expect(check?.details).toEqual([]);
  });

  it("passes once the ComfyUI URL is set", async () => {
    const projectDir = await initWithPolicyVideo(
      videoWithAsset(
        "adapters",
        `asset("canvas", adapters.jsxImage, { width: 1920, height: 1080 })`,
      ),
    );
    await writeWorkspaceConfig(projectDir, {
      comfy: { comfyui: { url: "http://127.0.0.1:8188" } },
    });

    const check = await backendCheck(projectDir);
    expect(check?.status).toBe("PASS");
    expect(check?.message).toContain("[comfy] configured");
  });
});

describe("doctor command (git tracking)", () => {
  const address = "video:shot.01.motion";
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithNoBackendVideo();
  });

  it("fails on an accepted variant whose media is missing", async () => {
    const sm = await StateManager.load(projectDir);
    const v = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v]!.file = `assets/video/shot.01.motion/${v}/out.mp4`;
    sm.setAccepted(address, v);
    await sm.save();

    const check = await doctorCheck(projectDir, "missing assets");

    expect(check?.status).toBe("FAIL");
    expect(check?.message).toContain("not committed");
    expect(check?.message).not.toContain("Git LFS");
  });

  it("fails on an accepted variant whose media is an unfetched Git LFS pointer", async () => {
    const sm = await StateManager.load(projectDir);
    const v = sm.reserveVariantId(address);
    const file = `assets/video/shot.01.motion/${v}/out.mp4`;
    sm.getAssetState(address).variants![v]!.file = file;
    sm.setAccepted(address, v);
    await sm.save();
    await fs.mkdir(path.dirname(path.join(projectDir, file)), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, file),
      "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 1234\n",
    );

    const check = await doctorCheck(projectDir, "missing assets");

    expect(check?.status).toBe("FAIL");
    expect(check?.message).toContain("git lfs pull");
    expect(check?.message).not.toContain("not committed");
    expect(check?.details?.[0]).toContain("Git LFS pointer");
  });

  it("passes over an absent variant", async () => {
    const sm = await StateManager.load(projectDir);
    const v = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v]!.file = `assets/video/shot.01.motion/${v}/out.mp4`;
    await sm.save();

    expect((await doctorCheck(projectDir, "missing assets"))?.status).toBe("PASS");
  });

  it("warns about a variant directory no state row records", async () => {
    expect((await doctorCheck(projectDir, "stray variant directories"))?.status).toBe("PASS");

    await fs.mkdir(path.join(projectDir, "assets/video/shot.01.motion/v-stray001"), {
      recursive: true,
    });

    const check = await doctorCheck(projectDir, "stray variant directories");
    expect(check?.status).toBe("WARN");
    expect(check?.message).toContain("assets/video/shot.01.motion/v-stray001");
    expect(check?.message).toContain("konte prune");
  });

  it("warns when assets/.gitignore drifts from the state", async () => {
    expect((await doctorCheck(projectDir, "assets/.gitignore"))?.status).toBe("PASS");

    await fs.appendFile(path.join(projectDir, "assets", ".gitignore"), "!/video/\n");

    expect((await doctorCheck(projectDir, "assets/.gitignore"))?.status).toBe("WARN");
  });
});

describe("doctor command (text output)", () => {
  // Give doctor one real WARN to report: an orphaned target (same shape as the JSON test above).
  async function projectWithAWarning(): Promise<string> {
    const projectDir = await initWithNoBackendVideo();
    const sm = await StateManager.load(projectDir);
    const orphan = "video:shot.99.old";
    const v = sm.reserveVariantId(orphan);
    sm.setAccepted(orphan, v);
    await sm.save();
    return projectDir;
  }

  it("hides passing checks and prints only problems plus a summary", async () => {
    const projectDir = await projectWithAWarning();
    const { stdout } = await runCapture(["doctor"], projectDir);

    expect(stdout).not.toContain("✓ PASS");
    expect(stdout).toContain("! WARN orphaned targets");
    expect(stdout).toMatch(/\d+ warning\(s\)\./);
  });

  it("shows every check, including passing ones, with --all", async () => {
    const projectDir = await projectWithAWarning();
    const { stdout } = await runCapture(["doctor", "--all"], projectDir);

    expect(stdout).toContain("✓ PASS");
    expect(stdout).toContain("! WARN orphaned targets");
  });
});

// The location anchor is a direction finding that reads the ANIMATIC, so it only fires if the board's
// reference reach actually arrives at `checkDirection` — a wiring these tests exist to hold.
describe("doctor command (location reference)", () => {
  const DIRECTION_TS = `import { defineDirection, defineLens } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
    side: { name: "the side angle", description: "in from the side", location: "studio", framing: "close", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en", speech: "free" },
  lenses: [defineLens({ name: "two-beat", payoff: "beat", roles: [{ role: "beat" }, { role: "beat" }] })],
  sequence: {
    lens: "two-beat",
    pleasure: "cute",
    shots: [
      { id: "01", role: "beat", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "beat", action: "later shot", setup: "side", duration: 5 , lineup: [] },
    ],
  },
});
`;

  const REFERENCE_TSX = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const studio = asset("studio", internalTestPlate, { width: 64, height: 64, color: "#eee" });
  return { studio };
});
`;

  const animaticWith = (
    keyframe: string,
  ) => `import { defineAnimatic, asset, Composition, Panel } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestImage, internalTestPlate } from "konte";
import direction from "./direction";
import reference from "./reference";

export default defineAnimatic(direction, {
  timeline: ({ shot }) => {
    return { shots: shot("01", () => <Composition>
<Panel src={${keyframe}} blocking="she stands at the desk" camera="fixed" />
</Composition>)
      .nextShot("02", () => <Composition>
<Panel src={${keyframe}} blocking="her hands rest on the desk" camera="fixed" />
</Composition>) };
  },
});
`;

  const FROM_LOCATION = `asset("first", internalTestImage, { image: reference.studio, width: 64, height: 64 })`;
  const FROM_NOTHING = `asset("first", internalTestImage, { width: 64, height: 64 })`;
  // One outcome, so nothing an anchor could hold still.
  const DETERMINISTIC = `asset("first", internalTestPlate, { width: 64, height: 64, color: "#fff" })`;

  async function setupProject(keyframe: string): Promise<string> {
    const projectDir = await initWithNoBackendVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_TSX);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), animaticWith(keyframe));
    await acceptDirection(projectDir);
    return projectDir;
  }

  async function findingCodes(keyframe: string): Promise<string> {
    const projectDir = await setupProject(keyframe);
    return ((await doctorCheck(projectDir, "direction"))?.details ?? []).join("\n");
  }

  it("demands the location reference of a keyframe built from nothing", async () => {
    const codes = await findingCodes(FROM_NOTHING);
    expect(codes).toContain("location-unconsumed_01");
    expect(codes).toContain("location-unconsumed_02");
    expect(codes).toContain("reference.studio");
  });

  it("clears once the keyframe is built from the location reference", async () => {
    expect(await findingCodes(FROM_LOCATION)).not.toContain("location-unconsumed");
  });

  // A picture with one outcome cannot drift take to take, so no anchor is owed of it.
  it("exempts a keyframe with no generative step", async () => {
    expect(await findingCodes(DETERMINISTIC)).not.toContain("location-unconsumed");
  });

  it("aborts generate on it", async () => {
    const projectDir = await setupProject(FROM_NOTHING);
    const { stderr } = await runCapture(["generate", "animatic", "--plan"], projectDir);
    expect(stderr).toContain("DIRECTION_CHECK_FAILED");
    expect(stderr).toContain("location-unconsumed_01");
  });

  // Past the direction check, the spend stops at the next gate: the sheet it now consumes.
  it("lets generate past it once the keyframe is built from the location reference", async () => {
    const projectDir = await setupProject(FROM_LOCATION);
    const { stderr } = await runCapture(["generate", "animatic", "--plan"], projectDir);
    expect(stderr).toContain("REFERENCE_ACCEPTANCE_REQUIRED");
  });
});
