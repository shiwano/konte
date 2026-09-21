import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import { generateFeedbackId } from "../../core/feedback/index.js";
import {
  acceptDirection,
  ctx,
  useTempWorkspace,
  initWithTestVideo,
  initWithDepsVideo,
  initWithCrossStageVideo,
  run,
  initWorkspace,
  seedFeedback,
  TEST_EMPTY_ANIMATIC_TSX,
  TEST_VIDEO_TSX,
  TEST_VIDEO_WITH_SOUNDTRACK_TSX,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

// A video whose adapters type their text: the two conditioning halves and the words a speech model
// voices. TEST_VIDEO_TSX types all three `"string"`, so it collects nothing to list.
const TYPED_TEXT_VIDEO_TSX = TEST_VIDEO_TSX.replace(
  `const animateComfy = defineComfyAsset({
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
});`,
  `const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    negative: { nodeId: "4", field: "text", type: "negativePrompt" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "spokenText" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});`,
).replace(
  `const motion = asset("motion", animateComfy, { prompt: "test" });
      const voice = asset("voice", ttsComfy, { text: "hello" });`,
  `const motion = asset("motion", animateComfy, { prompt: "a wide shot", negative: "blurry" });
      const voice = asset("voice", ttsComfy, { text: "a line to be read aloud" });`,
);

describe("inspect --prompts", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
    await fs.writeFile(path.join(projectDir, "video.tsx"), TYPED_TEXT_VIDEO_TSX);
  });

  it("lists every kind of model-bound text under a stage scope", async () => {
    const { stdout } = await run(["inspect", "video", "--prompts"], projectDir);
    expect(stdout).toContain("video:shot.01.motion");
    expect(stdout).toContain("a wide shot");
    expect(stdout).toContain("blurry");
    expect(stdout).toContain("video:shot.01.voice");
    expect(stdout).toContain("a line to be read aloud");
  });

  it("marks the spoken line as its own kind", async () => {
    const { stdout } = await run(["inspect", "video", "--prompts"], projectDir);
    expect(stdout).toMatch(/\(prompt\)\n {6}a wide shot$/m);
    expect(stdout).toMatch(/\(negativePrompt\)\n {6}blurry$/m);
    expect(stdout).toMatch(/\(spokenText\)\n {6}a line to be read aloud$/m);
  });

  it("narrows to one address", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.voice", "--prompts"], projectDir);
    expect(stdout).toContain("a line to be read aloud");
    expect(stdout).not.toContain("a wide shot");
  });

  // The shot's declared lineup is printed beside the prompt it was supposed to be written from —
  // konte never expands it into prompt text, so this listing is the whole handover.
  it("states the shot's lineup above its prompts", async () => {
    const file = path.join(projectDir, "direction.ts");
    const staged = (await fs.readFile(file, "utf8"))
      .replace(
        `  characters: {
    character: {`,
        `  characters: {
    helper: {
      name: "the helper",
      promptDepiction: "helper",
      description: "A second pair of hands at the desk.",
    },
    character: {`,
      )
      .replace(
        `        setup: "deskWide",
        lineup: [],`,
        `        setup: "deskWide",
        lineup: ["character", "helper"],
        lineupTo: ["helper", "character"],`,
      );
    await fs.writeFile(file, staged);

    const { stdout } = await run(["inspect", "video:shot.01.motion", "--prompts"], projectDir);
    expect(stdout).toContain(
      "lineup: the creator (character) | the helper (helper) \u2192 the helper (helper) | the creator (character)",
    );
  });

  it("states what the shot lands above its prompts", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.motion", "--prompts"], projectDir);
    expect(stdout).toContain(
      "action: Plan the story — the creator sketches each shot in the animatic.",
    );
  });

  // The `set:` line is the other half of the handover: what the shot's frame carries of its place,
  // left to right. A critic cannot read direction.ts, so the plate's sentence is checked against this.
  it("states what the shot's frame holds of its place", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.motion", "--prompts"], projectDir);
    expect(stdout).toContain("set: the mark (studioMark)");
  });

  // An insert fills the frame with an object and shows no set, so there is no line to print.
  it("prints no `set:` line for a frame that holds nothing", async () => {
    const file = path.join(projectDir, "direction.ts");
    const staged = (await fs.readFile(file, "utf8")).replace(
      `      framing: "wide",
      holds: ["studioMark"],`,
      `      framing: "insert",
      holds: [],`,
    );
    await fs.writeFile(file, staged);

    const { stdout } = await run(["inspect", "video:shot.01.motion", "--prompts"], projectDir);
    expect(stdout).not.toContain("set:");
  });

  it("reports an empty scope rather than failing", async () => {
    const { stdout } = await run(["inspect", "direction", "--prompts"], projectDir);
    expect(stdout).toContain("No prompts");
  });

  it("keeps a spoken line out of the prompt check", async () => {
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TYPED_TEXT_VIDEO_TSX.replace("a line to be read aloud", "there is no way out of here"),
    );
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("no way out");
  });
});

describe("inspect command", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("shows asset details", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.motion"], projectDir);
    expect(stdout).toContain("video:shot.01.motion");
    expect(stdout).toContain("comfy");
  });

  it("reports the asset's address, its inputs and both edges", async () => {
    const { stdout } = await run(["inspect", "video:shot.01.motion"], projectDir);
    expect(stdout).toContain("Address: video:shot.01.motion");
    expect(stdout).toContain("Inputs:");
    expect(stdout).toMatch(/^Dependencies:/m);
    expect(stdout).toMatch(/^Dependents:/m);
  });

  it("fails for non-existent address", async () => {
    await expect(run(["inspect", "video:shot.99.nonexistent"], projectDir)).rejects.toThrow();
  });

  it("accepts a bare stage scope", async () => {
    const { stdout } = await run(["inspect", "video"], projectDir);
    expect(stdout).toContain("Shot: 01 (0s — 5s, 5s)");
    expect(stdout).toContain("video:shot.01.motion");
  });

  it("rejects a scope with a trailing separator", async () => {
    for (const scope of ["video:", "video@", "video:shot.01."]) {
      await expect(run(["inspect", scope], projectDir)).rejects.toThrow();
    }
  });
});

// The reference stage's assets live in a flat pool with bare addresses (`reference:<name>`), so its
// scopes need their own coverage — the animatic/video grammar would otherwise reject `reference`
// outright.

describe("inspect command (reference scope)", () => {
  let projectDir: string;

  beforeEach(async () => {
    const inited_refproj = await initWorkspace(path.join(ctx.dir, "refproj"));
    projectDir = inited_refproj.video;
  });

  it("shows the whole reference stage by bare scope", async () => {
    const { stdout } = await run(["inspect", "reference"], projectDir);
    expect(stdout).toContain("Reference:");
    expect(stdout).toContain("reference:character");
    expect(stdout).toContain("reference:bgm");
  });

  it("lists the reference stage with bare addresses", async () => {
    const { stdout } = await run(["inspect", "reference"], projectDir);
    expect(stdout).toContain("reference:character");
    expect(stdout).toContain("reference:bgm");
    // Reference addresses are bare — never `timeline.`-prefixed like the video/animatic pool.
    expect(stdout).not.toContain(":timeline.");
  });

  it("shows a single reference asset", async () => {
    const { stdout } = await run(["inspect", "reference:bgm"], projectDir);
    expect(stdout).toContain("Address: reference:bgm");
    expect(stdout).toContain("Kind: file");
  });

  it("rejects a profile-bearing reference scope and trailing separators", async () => {
    for (const scope of ["reference@main", "reference:", "reference@", "reference@static:"]) {
      await expect(run(["inspect", scope], projectDir)).rejects.toThrow();
    }
  });
});

// Feedback and the no-job leaves (composition, stem) are what a listing has to carry for an asset
// stage to answer the same questions the direction stage does: what is signed off, and what has
// someone written on it.

describe("inspect command (feedback and leaves)", () => {
  let projectDir: string;
  const motion = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  async function seed(
    address: string,
    text: string,
    displayedVariants: Record<string, string> = {},
  ) {
    const id = generateFeedbackId();
    const { assets } = (await StateManager.load(projectDir)).getState();
    const lastDecidedAt = Math.max(
      Date.now(),
      ...Object.values(assets).flatMap((a) =>
        Object.values(a.variants ?? {}).map((v) => (v.decidedAt ? Date.parse(v.decidedAt) : 0)),
      ),
    );
    await seedFeedback(projectDir, address, {
      id,
      displayedVariants,
      annotation: null,
      text,
      // After any accept this fixture made: an accept stamped over a comment ages it, and these
      // are here to read as advice that still stands. Offset from the recorded stamps too, since
      // the clock can step backwards mid-test.
      createdAt: new Date(lastDecidedAt + 1_000).toISOString(),
      createdBy: "local",
    });
    return id;
  }

  // A live comment reads as current advice; a stale one argues with a state that no longer exists,
  // so it is counted and not quoted.
  async function seedStale(address: string, text: string) {
    const sm = await StateManager.load(projectDir);
    const shown = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![shown]!.file = "/tmp/a.mp4";
    const newer = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![newer]!.file = "/tmp/b.mp4";
    sm.setAccepted(address, newer);
    await sm.save();
    return seed(address, text, { [address]: shown });
  }

  it("prints an asset's live feedback and only counts the stale", async () => {
    const live = await seed(motion, "Fix the color grading");
    const stale = await seedStale(motion, "About the old take");
    const { stdout } = await run(["inspect", motion], projectDir);
    expect(stdout).toContain("Feedback: 2 comments, 1 stale");
    expect(stdout).toContain(`[${live}] Fix the color grading`);
    expect(stdout).not.toContain("About the old take");
    expect(stdout).not.toContain(stale);
  });

  it("surfaces whole-shot feedback at shot scope", async () => {
    const id = await seed("video:shot.01", "The cut lands late");
    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    expect(stdout).toContain("Feedback: 1 comment");
    expect(stdout).toContain("The cut lands late");
    expect(stdout).toContain(id);
  });

  it("tags each listing line with its comment count", async () => {
    await seed(motion, "Fix the color grading");
    await seed("video:shot.01", "The cut lands late");
    const { stdout } = await run(["inspect", "video"], projectDir);
    expect(stdout).toContain("Shot: 01 (0s — 5s, 5s) [1 comment]");
    expect(stdout).toContain("video:shot.01.motion (comfy): - [1 comment]");
  });

  it("lists the shot's composition and stem at stage scope", async () => {
    const { stdout } = await run(["inspect", "video"], projectDir);
    expect(stdout).toContain("video:shot.01#composition (composition):");
    expect(stdout).toContain("video:shot.01#stem (stem):");
  });

  it("lists the timeline stem of a video with soundtrack beds", async () => {
    await fs.writeFile(path.join(projectDir, "video.tsx"), TEST_VIDEO_WITH_SOUNDTRACK_TSX);
    const { stdout } = await run(["inspect", "video"], projectDir);
    expect(stdout).toContain("Timeline:");
    expect(stdout).toContain("video:timeline#stem (stem):");
  });
});

// The direction stage has no assets, so its scopes report the direction's reviewable parts instead —
// a grammar (`direction:<part>`) the asset forms would reject outright.

describe("inspect command (direction scope)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("lists every direction part with its acceptance status", async () => {
    const { stdout } = await run(["inspect", "direction"], projectDir);
    expect(stdout).toContain("Stage: direction");
    expect(stdout).toMatch(/Acceptance: (unaccepted|partial)/);
    expect(stdout).toContain("direction:brief.logline");
    expect(stdout).toContain("direction:sequence.shots.01");
    expect(stdout).toContain("unaccepted");
  });

  it("groups each part under its section, with nothing orphaned", async () => {
    const { stdout } = await run(["inspect", "direction"], projectDir);
    expect(stdout).toContain("shots: unaccepted");
    expect(stdout).toMatch(/^ {2}direction:sequence\.shots\.01 +unaccepted/m);
    expect(stdout).not.toContain("Orphans");
  });

  it("reports acceptance once the direction is signed off", async () => {
    await acceptDirection(projectDir);
    const { stdout } = await run(["inspect", "direction"], projectDir);
    expect(stdout).toMatch(/Acceptance: accepted \(\d+ parts\)/);
    expect(stdout).not.toContain("unaccepted");
  });

  it("shows one part in depth", async () => {
    const { stdout } = await run(["inspect", "direction:sequence.shots.01"], projectDir);
    expect(stdout).toContain("Address: direction:sequence.shots.01");
    expect(stdout).toContain("Section: shots");
    expect(stdout).toContain("Acceptance: unaccepted");
    expect(stdout).toContain("Shot: 01");
    expect(stdout).toContain("Role:     method");
    // The shot's on-screen text, printed under the action it belongs to.
    expect(stdout).toContain("Telop:");
    expect(stdout).toContain("Animatic it.");
  });

  it("shows a brief field in depth", async () => {
    const { stdout } = await run(["inspect", "direction:brief.logline"], projectDir);
    expect(stdout).toContain("Address: direction:brief.logline");
    expect(stdout).toContain("Section: brief");
    expect(stdout).toContain("Brief: logline");
    expect(stdout).not.toContain("Feedback:");
  });

  // A list field is a part even when the brief declares nothing in it — the empty list is the
  // position, and a reviewer's note on it is how an entry gets added.
  it("shows an emptied list field as a part of its own", async () => {
    const file = path.join(projectDir, "direction.ts");
    const source = await fs.readFile(file, "utf-8");
    await fs.writeFile(file, source.replace(/tolerances: \[[\s\S]*?\],/, "tolerances: [],"));
    const { stdout } = await run(["inspect", "direction:brief.tolerances"], projectDir);
    expect(stdout).toContain("Address: direction:brief.tolerances");
    expect(stdout).toContain("Brief: tolerances");
    expect(stdout).toContain("none");
  });

  // A container scope reads a whole section in one command — the brief's six fields, the roster, the
  // shots — so no section needs a command of its own.
  it("shows every part under a container scope", async () => {
    const { stdout } = await run(["inspect", "direction:brief"], projectDir);
    expect(stdout).toContain("Scope: direction:brief");
    expect(stdout).toContain("Parts: 6");
    expect(stdout).toContain("direction:brief.logline  unaccepted");
    expect(stdout).toContain("direction:brief.tolerances  unaccepted");
    expect(stdout).toContain("Clean anime illustration");
    // The address heads each block, so the single-part scaffolding is not repeated per field.
    expect(stdout).not.toContain("Brief: logline");
    expect(stdout).not.toContain("direction:policy.");
  });

  it("reaches the parts nested under a container scope", async () => {
    const { stdout } = await run(["inspect", "direction:characters"], projectDir);
    expect(stdout).toContain("Scope: direction:characters");
    expect(stdout).toContain("direction:characters.character");
  });

  // `direction:sequence` is both a part (the root arc) and the prefix over every shot; the part wins,
  // so a scope that names a part always reads as that part.
  it("reads a scope that is itself a part as that part", async () => {
    const { stdout } = await run(["inspect", "direction:sequence"], projectDir);
    expect(stdout).toContain("Address: direction:sequence");
    expect(stdout).not.toContain("Scope: direction:sequence");
  });

  it("fails for a container scope the direction has nothing under", async () => {
    await expect(run(["inspect", "direction:props"], projectDir)).rejects.toThrow();
  });

  it("fails for a part the direction does not declare", async () => {
    await expect(run(["inspect", "direction:characters.nobody"], projectDir)).rejects.toThrow();
  });

  it("rejects a malformed direction scope", async () => {
    for (const scope of ["direction:", "direction:brief.", "direction:brief.nosuchfield"]) {
      await expect(run(["inspect", scope], projectDir)).rejects.toThrow();
    }
  });

  it("fails when the video has no direction.ts", async () => {
    await fs.rm(path.join(projectDir, "direction.ts"));
    await expect(run(["inspect", "direction"], projectDir)).rejects.toThrow();
  });
});

describe("ref command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("prints accepted variant's file path", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/motion-1.mp4";
    sm.setAccepted(address, v1);
    await sm.save();

    const { stdout } = await run(["ref", address], projectDir);
    expect(stdout.trim()).toBe("/tmp/motion-1.mp4");
  });

  it("falls back to latest non-stale ready variant when none accepted", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/old.mp4";
    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = "/tmp/new.mp4";
    await sm.save();

    const { stdout } = await run(["ref", address], projectDir);
    expect(stdout.trim()).toBe("/tmp/new.mp4");
  });

  it("skips stale variants in fallback", async () => {
    const sm = await StateManager.load(projectDir);

    // An upstream asset whose accepted output hash has moved on.
    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);

    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/fresh.mp4";
    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = "/tmp/stale.mp4";
    // v2 consumed the upstream at an older output hash -> computed input-stale.
    sm.getAssetState(address).variants![v2]!.inputFingerprints = {
      "video:shot.01.first": "up-old",
    };
    await sm.save();

    const { stdout } = await run(["ref", address], projectDir);
    expect(stdout.trim()).toBe("/tmp/fresh.mp4");
  });

  it("prints the newest stale take, with a notice, when every take is stale", async () => {
    const sm = await StateManager.load(projectDir);

    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);

    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/stale.mp4";
    sm.getAssetState(address).variants![v1]!.inputFingerprints = { [upstream]: "up-old" };
    await sm.save();

    const { stdout, stderr } = await run(["ref", address], projectDir);
    expect(stdout.trim()).toBe("/tmp/stale.mp4");
    expect(stderr).toContain("stale take");
    expect(stderr).toContain(`konte reroll ${address}`);
  });

  it("exits non-zero when no ready variant exists", async () => {
    await expect(run(["ref", address], projectDir)).rejects.toThrow();
  });

  it("prints one path per address, in the order given", async () => {
    const other = "video:shot.01.first";
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/motion-1.mp4";
    const v2 = sm.reserveVariantId(other);
    sm.getAssetState(other).variants![v2]!.file = "/tmp/first-1.png";
    await sm.save();

    const { stdout } = await run(["ref", other, address], projectDir);
    expect(stdout.trim().split("\n")).toEqual(["/tmp/first-1.png", "/tmp/motion-1.mp4"]);
  });

  it("prints the named variant's path, even one the address does not resolve to", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/accepted.mp4";
    sm.setAccepted(address, v1);
    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = "/tmp/patched.mp4";
    sm.getAssetState(address).variants![v2]!.derivedFrom = v1;
    await sm.save();

    expect((await run(["ref", address], projectDir)).stdout.trim()).toBe("/tmp/accepted.mp4");
    expect((await run(["ref", v2], projectDir)).stdout.trim()).toBe("/tmp/patched.mp4");
  });

  it("mixes addresses and variant ids, in the order given", async () => {
    const other = "video:shot.01.first";
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/motion-1.mp4";
    const v2 = sm.reserveVariantId(other);
    sm.getAssetState(other).variants![v2]!.file = "/tmp/first-1.png";
    await sm.save();

    const { stdout } = await run(["ref", v1, other], projectDir);
    expect(stdout.trim().split("\n")).toEqual(["/tmp/motion-1.mp4", "/tmp/first-1.png"]);
  });

  it("fails for an unknown variant id", async () => {
    await expect(run(["ref", "v-nosuchtake"], projectDir)).rejects.toThrow(/v-nosuchtake/);
  });

  it("fails for a named variant with no file", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    await sm.save();

    await expect(run(["ref", v1], projectDir)).rejects.toThrow(new RegExp(v1));
  });

  it("prints nothing and fails when any of the addresses has no ready variant", async () => {
    const sm = await StateManager.load(projectDir);
    const v1 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v1]!.file = "/tmp/motion-1.mp4";
    await sm.save();

    await expect(run(["ref", address, "video:shot.01.first"], projectDir)).rejects.toThrow(
      /video:shot\.01\.first/,
    );
  });
});

describe("inspect command (variant details)", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("shows variant details in text output", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![vid]!.file = "/tmp/motion-1.mp4";
    await sm.save();

    const { stdout } = await run(["inspect", address], projectDir);
    expect(stdout).toContain(vid);
    expect(stdout).toContain("/tmp/motion-1.mp4");
  });
});

describe("inspect command (shot scope)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("lists the shot's timing and every asset under it, leaves included", async () => {
    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    expect(stdout).toContain("Shot: 01");
    expect(stdout).toContain("Duration: 5s");
    expect(stdout).toContain("Timeline: 0s — 5s");
    // 2 generation assets + the shot's two no-job leaves (composition, stem)
    const assets = stdout.slice(stdout.indexOf("Assets:")).split("\n").slice(1);
    expect(assets.filter((line) => line.startsWith("  "))).toHaveLength(4);
    expect(stdout).toContain("video:shot.01#composition (composition):");
    expect(stdout).toContain("video:shot.01#stem (stem):");
  });

  it("prints the shot's direction facts and its telop", async () => {
    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    expect(stdout).toContain("Role: method");
    expect(stdout).toContain("Setup:    deskWide");
    expect(stdout).toContain("Framing:  wide");
    expect(stdout).toContain("Location: studio");
    expect(stdout).toContain("Telop:");
    expect(stdout).toContain("Animatic it.");
  });

  it("carries no direction shot when the video has no direction.ts", async () => {
    // The board is a required entry, so it has to survive the direction going away.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_EMPTY_ANIMATIC_TSX, "utf-8");
    await fs.rm(path.join(projectDir, "direction.ts"));
    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    expect(stdout).not.toContain("Role:");
  });

  it("fails for non-existent shot", async () => {
    await expect(run(["inspect", "video:shot.99"], projectDir)).rejects.toThrow();
  });

  it("fails for invalid address-scope format", async () => {
    await expect(run(["inspect", "invalid-format"], projectDir)).rejects.toThrow();
  });
});

describe("inspect command (why-stale)", () => {
  let projectDir: string;
  const motionAddr = "video:shot.01.motion";
  const finalAddr = "video:shot.01.final";

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
  });

  // Accepted `final` recorded `motion`'s old output; `motion`'s accepted output
  // has since moved on -> `final` is input-stale on `video:shot.01.motion`.
  async function setupInputStale(): Promise<void> {
    const sm = await StateManager.load(projectDir);

    const m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "/tmp/motion.mp4";
    sm.getAssetState(motionAddr).variants![m1]!.outputHash = "motion-new";
    sm.setAccepted(motionAddr, m1);

    const fin = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![fin]!.file = "/tmp/final.mp4";
    sm.getAssetState(finalAddr).variants![fin]!.inputFingerprints = {
      "video:shot.01.motion": "motion-old",
    };
    sm.setAccepted(finalAddr, fin);
    await sm.save();
  }

  it("explains the changed input in asset text output", async () => {
    await setupInputStale();
    const { stdout } = await run(["inspect", finalAddr], projectDir);
    expect(stdout).toContain("Stale: yes");
    expect(stdout).toContain("input-stale: video:shot.01.motion changed (motion-o → motion-n)");
    expect(stdout).toContain("Accepted against an older upstream; the accept stands");
  });

  it("judges the Stale line by the resolved take, not a dismissed one", async () => {
    const sm = await StateManager.load(projectDir);
    const old = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![old]!.file = "/tmp/old.mp4";
    sm.getAssetState(motionAddr).variants![old]!.definitionHash = "stale-definition-hash";
    sm.getAssetState(motionAddr).variants![old]!.status = "dismissed";
    const acc = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![acc]!.file = "/tmp/motion.mp4";
    sm.setAccepted(motionAddr, acc);
    await sm.save();

    const { stdout } = await run(["inspect", motionAddr], projectDir);
    expect(stdout).toContain("Stale: no");
    expect(stdout).toContain(`${old}: dismissed (definition-stale)`);
  });

  it("surfaces input-stale at shot scope", async () => {
    await setupInputStale();
    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    const finalLine = stdout.split("\n").find((line) => line.includes(finalAddr));
    expect(finalLine).toContain("input-stale");
    expect(finalLine).toContain("video:shot.01.motion");
  });

  // Regression: shot/profile/stage used to compute staleness with defHash=null,
  // so definition-stale was never detected at those scopes.
  it("detects definition-stale at shot scope", async () => {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![vid]!.file = "/tmp/motion.mp4";
    sm.getAssetState(motionAddr).variants![vid]!.definitionHash = "stale-definition-hash";
    sm.setAccepted(motionAddr, vid);
    await sm.save();

    const { stdout } = await run(["inspect", "video:shot.01"], projectDir);
    const motionLine = stdout.split("\n").find((line) => line.includes(motionAddr));
    expect(motionLine).toContain("definition-stale");
  });
});

// The leaf's hash is the board's, read from the board — asked of the video definition it named
// another shot's composition, or none.
describe("inspect command (animatic leaves)", () => {
  it("inspects an animatic composition against the animatic definition", async () => {
    const board = await initWithCrossStageVideo();
    await acceptDirection(board);
    const dependencies = (stdout: string): string[] => {
      const lines = stdout.slice(stdout.indexOf("Dependencies:")).split("\n").slice(1);
      const end = lines.findIndex((line) => !line.startsWith("  "));
      return lines
        .slice(0, end === -1 ? lines.length : end)
        .map((line) => line.trim().split(" ")[0]!);
    };

    const { stdout } = await run(["inspect", "animatic:shot.01#composition"], board);
    expect(stdout).toContain("Address: animatic:shot.01#composition");
    expect(stdout).toContain("Kind: composition");
    // The board shot's own ref — read from the video definition this would be the motion clip.
    expect(dependencies(stdout)).toEqual(["animatic:shot.01.keyframe"]);

    const video = await run(["inspect", "video:shot.01#composition"], board);
    expect(dependencies(video.stdout)).toEqual(["video:shot.01.motion"]);
  });
});
