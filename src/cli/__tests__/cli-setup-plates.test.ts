import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  acceptDirection,
  initWithNoBackendVideo,
  run,
  runCapture,
  useTempWorkspace,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

// A plate is generated BEFORE the shots that stand on it exist, and the shots that do stand on it
// must build from it. Those are the two halves of what `plates` buys over a timeline asset named
// after the roster id, and both are only visible through `generate`.

describe("setup plates", () => {
  const DIRECTION_TS = `import { defineDirection, defineLens } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioWindow: { name: "the window", promptDepiction: "window", description: "the tall window along the far wall" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioWindow"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en", speech: "free" },
  lenses: [defineLens({ name: "two-beat", payoff: "beat", beats: [{ role: "beat" }, { role: "beat" }] })],
  sequence: {
    lens: "two-beat",
    pleasure: "cute",
    shots: [
      { id: "01", role: "beat", action: "test shot", setup: "front", duration: 5 , lineup: [] },
      { id: "02", role: "beat", action: "later shot", setup: "front", duration: 5 , lineup: [], join: "jump-forward" },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});
`;

  const PLATE = `plates: ({ format }) => ({
    front: {
      image: asset("front", internalTestImage, { width: format.size.width, height: format.size.height }),
      prompt: "the studio, its window along the far wall",
    },
  }),`;

  const FROM_PLATE = `asset("first", internalTestImage, { image: plates.front.image, width: 32, height: 32 })`;
  const FROM_NOTHING = `asset("first", internalTestImage, { width: 32, height: 32 })`;
  // Declared beside a keyframe built from nothing, and never rendered: unused, so it must not stand
  // in for the keyframe.
  const DECOY = `(() => { asset("decoy", internalTestImage, { image: plates.front.image, width: 8, height: 8 }); return ${FROM_NOTHING}; })()`;

  // `blocking`/`camera` on every panel: an accept cascade skips a dep whose review prerequisites are
  // unwritten, so a board without them never reaches the plate.
  const DEVELOPED = (keyframe: string, extraLayer = "") => `shots: shot("01", () => <Composition>
${extraLayer}<Panel src={${keyframe}} blocking="she turns to the desk" camera="fixed" />
</Composition>)
      .nextShot("02", () => <Composition>
${extraLayer}<Panel src={${keyframe}} blocking="she looks up" camera="fixed" />
</Composition>)`;

  const PENDING = `shots: pendingShot("01").nextPendingShot("02")`;

  const animaticWith = (
    shots: string,
  ) => `import { defineAnimatic, asset, internalTestImage, Composition, Image, Panel } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  ${PLATE}
  timeline: ({ format, shot, pendingShot, plates }) => {
    return { ${shots} };
  },
});
`;

  async function project(shots: string): Promise<string> {
    const projectDir = await initWithNoBackendVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), animaticWith(shots));
    await acceptDirection(projectDir);
    return projectDir;
  }

  async function generated(shots: string): Promise<string> {
    const projectDir = await project(shots);
    await run(["generate", "animatic"], projectDir);
    await run(["job", "wait"], projectDir);
    return projectDir;
  }

  // The P1 this replaced: reachability said the plate was unused, because at the moment the plates
  // are baked every shot is still a pendingShot declaring nothing.
  it("generates a plate while every shot is still pending", async () => {
    const projectDir = await project(PENDING);
    const { stdout } = await run(["generate", "animatic"], projectDir);
    expect(stdout).not.toContain("unused");

    await run(["job", "wait"], projectDir);
    const sm = await StateManager.load(projectDir);
    const variants = Object.values(sm.getState().assets["animatic:plate.front"]?.variants ?? {});
    expect(variants.some((v) => v.file)).toBe(true);
  });

  // No accept is owed OF THE AUTHOR, but a plate is not konte's own take either — the frame it fixes
  // is delivered inside every panel on that setup. The verdict arrives sideways, through the
  // keyframe's job provenance, when the first panel standing on the plate is accepted.
  it("is signed off by the accept of a panel built on it", async () => {
    const projectDir = await generated(DEVELOPED(FROM_PLATE));

    const before = await StateManager.load(projectDir);
    expect(before.getAcceptedVariant("animatic:plate.front")).toBeNull();

    await run(["accept", "animatic:shot.01#composition", "-y"], projectDir);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant("animatic:plate.front")).not.toBeNull();
  });

  // Between baking a plate and developing the first shot on it, no panel shows the plate, so no page
  // could take a verdict on it. With ANOTHER setup's shots developed the stage has leaves, so the
  // undecidable detector is live too.
  it("is neither review work nor undecidable while its own shots are still pending", async () => {
    const projectDir = await initWithNoBackendVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), TWO_SETUP_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TWO_SETUP_ANIMATIC);
    await acceptDirection(projectDir);
    await run(["generate", "animatic"], projectDir);
    await run(["job", "wait"], projectDir);

    const { stdout } = await runCapture(["status", "-v"], projectDir);
    expect(stdout).not.toContain("animatic:plate.side");
    expect(stdout).not.toContain("no review surface offers one");
  });

  it("offers the fork and the reroll when a shared plate is edited under its accept", async () => {
    const projectDir = await generated(DEVELOPED(FROM_PLATE));
    await run(["accept", "animatic:shot.01#composition", "-y"], projectDir);

    const sm = await StateManager.load(projectDir);
    const vid = sm.getAcceptedVariant("animatic:plate.front")!;
    sm.getAssetState("animatic:plate.front").variants![vid]!.definitionHash = "before-the-edit";
    await sm.save();

    const { stderr } = await run(["generate", "animatic"], projectDir);
    expect(stderr).toContain("animatic:plate.front");
    expect(stderr).toContain("shared frame for shots 01, 02");
    expect(stderr).toContain("for one shot: fork the setup");
    expect(stderr).toContain("for all 2: konte reroll animatic:plate.front");
    expect(stderr).not.toContain("--with-dependents");
  });

  // `animatic:plate` is an address-scope of its own, which is what makes reading the plates one
  // command rather than a list of addresses.
  it("sweeps every plate under the animatic:plate scope", async () => {
    const projectDir = await generated(PENDING);
    const { stdout, stderr } = await runCapture(
      ["probe", "contact-sheet", "animatic:plate"],
      projectDir,
    );
    // The plate is the one take under this scope — a sheet with a cell in it is the scope resolving.
    expect(`${stdout}${stderr}`).toContain("1 cells");
  });

  // A plate cut or resized from a master reads no prompt, so `--prompts` would list nothing for it.
  it("lists what each plate holds under --prompts, prompt or not", async () => {
    const projectDir = await project(PENDING);
    const { stdout } = await run(["inspect", "animatic:plate", "--prompts"], projectDir);
    expect(stdout).toContain("animatic:plate.front");
    expect(stdout).toContain("plate: the studio, its window along the far wall");

    const { stdout: one } = await run(["inspect", "animatic:plate.front"], projectDir);
    expect(one).toContain("Plate: the studio, its window along the far wall");
  });

  it("refuses to spend on a shot that ignores its setup's plate", async () => {
    const projectDir = await project(DEVELOPED(FROM_NOTHING));
    await expect(run(["generate", "animatic"], projectDir)).rejects.toThrow();
    const { stdout, stderr } = await runCapture(["generate", "animatic"], projectDir);
    expect(`${stdout}${stderr}`).toContain("setup-unconsumed");
  });

  // The plate has to reach the KEYFRAME. An asset that merely sits in the shot's pool taking the
  // plate is unused, and must not stand in for a keyframe built from nothing.
  it("is not satisfied by an unrendered asset that takes the plate", async () => {
    const projectDir = await project(DEVELOPED(DECOY));
    const { stdout, stderr } = await runCapture(["generate", "animatic"], projectDir);
    expect(`${stdout}${stderr}`).toContain("setup-unconsumed");
  });

  // Nor by a layer the shot DOES render: an overlay drawn over the frame says nothing about the
  // frame the keyframe was drawn on, so `compositionRefs` is too wide a root.
  it("is not satisfied by a rendered overlay that takes the plate", async () => {
    const overlay = `<Image src={asset("overlay", internalTestImage, { image: plates.front.image, width: 8, height: 8 })} />
`;
    const projectDir = await project(DEVELOPED(FROM_NOTHING, overlay));
    const { stdout, stderr } = await runCapture(["generate", "animatic"], projectDir);
    expect(`${stdout}${stderr}`).toContain("setup-unconsumed");
  });

  it("spends once the keyframes build from the plate", async () => {
    const projectDir = await project(DEVELOPED(FROM_PLATE));
    await expect(run(["generate", "animatic"], projectDir)).resolves.toBeDefined();
  });
});

// `front` carries two developed shots, `side` two still-pending ones; both owe a plate.
const TWO_SETUP_DIRECTION_TS = `import { defineDirection, defineLens } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioWindow: { name: "the window", promptDepiction: "window", description: "the tall window along the far wall" }, studioDoor: { name: "the door", promptDepiction: "door", description: "the door in the near wall" } } } },
  setups: {
    front: { name: "f", description: "straight on", location: "studio", framing: "medium", holds: ["studioWindow"] },
    side: { name: "s", description: "from the side", location: "studio", framing: "wide", holds: ["studioDoor"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en", speech: "free" },
  lenses: [defineLens({ name: "four", payoff: "beat", beats: [{ role: "beat" }, { role: "beat" }, { role: "beat" }, { role: "beat" }] })],
  sequence: {
    lens: "four",
    pleasure: "cute",
    shots: [
      { id: "01", role: "beat", action: "a", setup: "front", duration: 3 , lineup: [] },
      { id: "02", role: "beat", action: "b", setup: "front", duration: 5 , lineup: [], join: "jump-forward" },
      { id: "03", role: "beat", action: "c", setup: "side", duration: 4 , lineup: [] },
      { id: "04", role: "beat", action: "d", setup: "side", duration: 6 , lineup: [], join: "jump-forward" },
    ],
    waivers: {
      "location-unreferenced_studio": "fixture has no reference stage exposing it",
      "undeclared-continuity_02-03": "fixture",
      "re-established-wide_04": "fixture",
    },
  },
});
`;

const TWO_SETUP_KEYFRAME = `asset("first", internalTestImage, { image: plates.front.image, width: 32, height: 32 })`;

const TWO_SETUP_ANIMATIC = `import { defineAnimatic, asset, internalTestImage, Composition, Panel } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  plates: ({ format }) => ({
    front: {
      image: asset("front", internalTestImage, { width: format.size.width, height: format.size.height }),
      prompt: "the studio, its window along the far wall",
    },
    side: {
      image: asset("side", internalTestImage, { width: format.size.width, height: format.size.height }),
      prompt: "the studio from the side, the door behind",
    },
  }),
  timeline: ({ shot, pendingShot, plates }) => ({
    shots: shot("01", () => <Composition><Panel src={${TWO_SETUP_KEYFRAME}} blocking="a" camera="fixed" /></Composition>)
      .nextShot("02", () => <Composition><Panel src={${TWO_SETUP_KEYFRAME}} blocking="b" camera="fixed" /></Composition>)
      .nextPendingShot("03")
      .nextPendingShot("04"),
  }),
});
`;
