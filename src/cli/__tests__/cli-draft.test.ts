import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ensureFfmpeg } from "../../core/ffmpeg.js";
import { ffmpegBin } from "../../core/ffmpeg-binary.js";
import { detectSceneChanges } from "../../core/thumbnail.js";
import { StateManager } from "../../core/state/manager.js";
import {
  acceptDirection,
  acceptFileAssets,
  initWithNoBackendVideo,
  run,
  runCapture,
  useTempWorkspace,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 60000 });

useTempWorkspace();

// A draft take is generated before the panels drawn from it are written, holds no verdict, and a
// new take of it moves nothing downstream.

describe("draft takes", () => {
  const DIRECTION_TS = `import { defineDirection, defineLens } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioWindow: { name: "the window", description: "the tall window along the far wall" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioWindow"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en", speech: "free" },
  lenses: [defineLens({ name: "two-beat", payoff: "beat", roles: [{ role: "beat" }, { role: "beat" }] })],
  sequence: {
    lens: "two-beat",
    pleasure: "cute",
    shots: [
      { id: "01", role: "beat", action: "test shot", setup: "front", duration: 2, lineup: [] },
      { id: "02", role: "beat", action: "later shot", setup: "front", duration: 2, lineup: [], join: "jump-forward" },
    ],
    waivers: {
      "location-unreferenced_studio": "fixture has no reference stage exposing it",
    },
  },
});
`;

  // `clip` stands in for a multi-shot model offline: a cut of a real file, and not deterministic,
  // so it rerolls.
  const animaticWith = (opts: { at?: number; length?: number; shots: "pending" | "drawn" }) =>
    `import { defineAnimatic, asset, adapters, internalTestImage, Composition, Panel } from "konte";
import direction from "./direction";
import reference from "./reference";

const clip = {
  type: "video",
  meta: { backend: "local", mediaType: "video", description: "test", ref: "trim", inputs: {} },
  createDefinition: (inputs) => ({
    kind: "local",
    operation: "trim",
    mediaType: "video",
    inputs: { source: inputs.source.src, start: 0, duration: inputs.duration },
  }),
};

export default defineAnimatic(direction, {
  drafts: ({ draft }) => ({
    opening: draft(["01", "02"], () =>
      asset("opening", clip, { source: reference.footage, duration: ${opts.length ?? 4} }),
    ),
  }),
  timeline: ({ shot, pendingShot, drafts }) => ({
    shots: ${
      opts.shots === "pending"
        ? `pendingShot("01").nextPendingShot("02")`
        : `shot("01", () => {
      const frame = drafts.opening.frame("01", "draftFirst", { at: ${opts.at ?? 0.5} });
      const first = asset("first", internalTestImage, { image: frame, width: 32, height: 32 });
      return <Composition>
<Panel src={first} blocking="she turns to the desk" camera="fixed" />
</Composition>;
    }).nextPendingShot("02")`
    },
  }),
});
`;

  // Two seconds of one colour, then two of another: one cut, at 2s.
  async function writeFootage(projectDir: string): Promise<void> {
    await ensureFfmpeg();
    const files = path.join(projectDir, "assets", "files");
    await fs.mkdir(files, { recursive: true });
    await promisify(execFile)(await ffmpegBin(), [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=128x128:d=2:r=30",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=128x128:d=2:r=30",
      "-filter_complex",
      "concat=n=2:v=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(files, "draft.mp4"),
    ]);
  }

  const REFERENCE_TSX = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";

export default defineReference(direction, () => ({
  footage: asset("footage", adapters.videoFile, { path: "assets/files/draft.mp4" }),
}));
`;

  const DRAFT = "animatic:draft.opening";
  const FRAME = "animatic:shot.01.draftFirst";
  const PANEL = "animatic:shot.01.first";

  async function project(animatic: string, direction = DIRECTION_TS): Promise<string> {
    const projectDir = await initWithNoBackendVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), direction);
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_TSX);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), animatic);
    await writeFootage(projectDir);
    await acceptDirection(projectDir);
    await acceptFileAssets(projectDir);
    return projectDir;
  }

  async function generate(projectDir: string): Promise<void> {
    await run(["generate", "animatic"], projectDir);
    await run(["job", "wait"], projectDir);
  }

  const takesOf = async (projectDir: string, address: string) =>
    Object.entries(
      (await StateManager.load(projectDir)).getState().assets[address]?.variants ?? {},
    );

  it("generates a draft while every shot on it is still pending", async () => {
    const projectDir = await project(animaticWith({ shots: "pending" }));
    await generate(projectDir);
    const takes = await takesOf(projectDir, DRAFT);
    expect(takes.some(([, v]) => v.file)).toBe(true);
    expect(takes.every(([, v]) => v.turbo !== true)).toBe(true);
  });

  it("reads a take's cuts beside the direction's", async () => {
    const projectDir = await project(animaticWith({ shots: "pending" }));
    await generate(projectDir);
    const { stdout } = await run(["probe", "cuts", DRAFT], projectDir);
    expect(stdout).toMatch(/01\s+0\.00s\s+\(take head\)/);
    expect(stdout).toMatch(/02\s+2\.00s\s+2\.00s \(\+0\.00\)/);
    expect(stdout).toMatch(/sheet {2}\S+strip-full-f17\.jpg/);
    expect(stdout).toContain("Next steps:");
  });

  // A take's prompt numbers its shots and a panel's name is the author's, so a critic barred from
  // the stage's internals is told which shot each `[Shot N]` is and which frame a panel redraws.
  it("names each shot of a take, and the frame a panel is drawn from, beside the prompts", async () => {
    const piece = animaticWith({ shots: "drawn" }).replace(
      `asset("opening", clip, { source: reference.footage, duration: 4 })`,
      `asset("opening", { ...clip, meta: { ...clip.meta, inputs: { prompt: { type: "prompt", required: true } } } }, { source: reference.footage, duration: 4, prompt: "two shots" })`,
    );
    const projectDir = await project(piece);
    const drafts = await run(["inspect", "animatic", "--prompts"], projectDir);
    expect(drafts.stdout).toContain(
      `frame: ${FRAME} — ${DRAFT} at 0.50s ([Shot 1], 0.50s past its stated cut)`,
    );
    expect(drafts.stdout).toContain(`${DRAFT}
  [Shot 1] shot 01 · at 0.00s · setup front
    action: test shot
    lineup: 
    set: the window (studioWindow)
  [Shot 2] shot 02 · at 2.00s · setup front
    action: later shot
    join: jump-forward
    lineup: 
    set: the window (studioWindow)
  prompt (prompt)
      two shots`);
  });

  it("is neither review work nor a take that holds a verdict", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);

    const status = await run(["status", "-v"], projectDir);
    expect(status.stdout).toContain(PANEL);
    expect(status.stdout).not.toContain(DRAFT);

    const refused = await runCapture(["accept", DRAFT, "-y"], projectDir);
    expect(refused.stderr).toContain("DRAFT_NOT_DECIDABLE");
    const dismissed = await runCapture(["dismiss", DRAFT, "-y"], projectDir);
    expect(dismissed.stderr).toContain("DRAFT_NOT_DECIDABLE");

    // The panel's accept signs off the frame it was drawn from and stops there.
    await run(["accept", "animatic:shot.01#composition", "-y"], projectDir);
    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant(PANEL)).not.toBeNull();
    expect(sm.getAcceptedVariant(FRAME)).not.toBeNull();
    expect(sm.getAcceptedVariant(DRAFT)).toBeNull();
  });

  it("records no fingerprint of the take on the frame cut from it", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);
    const frame = (await takesOf(projectDir, FRAME))[0]![1];
    expect(frame.file).toBeTruthy();
    expect(Object.keys(frame.inputFingerprints)).toEqual([]);
  });

  it("is not redone by generate once it has a take, whatever moved", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);
    await fs.writeFile(
      path.join(projectDir, "animatic.tsx"),
      animaticWith({ shots: "drawn", length: 3 }),
    );
    const { stdout } = await run(["generate", "animatic", "--plan"], projectDir);
    expect(stdout).toContain(`${DRAFT}: skip (already ready)`);
    expect(stdout).toContain(`${PANEL}: skip`);
  });

  it("takes a reroll as its newest take and moves no panel", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);
    const firstTake = (await takesOf(projectDir, DRAFT))[0]![0];

    const swept = await runCapture(["reroll", "animatic:draft", "--yes"], projectDir);
    expect(swept.stderr).toContain("No rerollable asset");

    const { stdout } = await run(["reroll", DRAFT], projectDir);
    expect(stdout).toContain("Next steps:");
    expect(stdout).toContain(`konte probe cuts ${DRAFT}`);
    expect(stdout).toContain("(01, 02)");
    await run(["job", "wait"], projectDir);

    const takes = await takesOf(projectDir, DRAFT);
    expect(takes).toHaveLength(2);
    const ref = await run(["ref", DRAFT], projectDir);
    const newest = takes.find(([id]) => id !== firstTake)![0];
    expect(ref.stdout).toContain(newest);

    const plan = await run(["generate", "animatic", "--plan"], projectDir);
    expect(plan.stdout).toContain(`${FRAME}: skip`);
    expect(plan.stdout).toContain(`${PANEL}: skip`);

    // The take in use is kept the way an accepted one is.
    await run(["clean", "animatic:draft", "--delete-unaccepted", "--yes"], projectDir);
    const kept = await takesOf(projectDir, DRAFT);
    expect(kept.map(([id]) => id)).toEqual([newest]);
  });

  it("names the frame a rerolled panel is drawn from", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);

    const { stdout } = await run(["reroll", PANEL], projectDir);
    expect(stdout).toContain("Next steps:");
    expect(stdout).toContain(`konte probe image ${FRAME}`);
    expect(stdout).toContain(`The frame ${PANEL} is drawn from`);
  });

  it("refuses a target that is no draft take, beside one that is", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);
    const mixed = await runCapture(["probe", "cuts", DRAFT, FRAME], projectDir);
    expect(mixed.stderr).toContain("INVALID_ADDRESS");
    expect(mixed.stdout).not.toContain("Next steps:");
  });

  // The take before is longer, so the next one continues from a cut of its tail.
  const continued = (
    firstLength: number,
  ) => `import { defineAnimatic, asset, adapters } from "konte";
import direction from "./direction";
import reference from "./reference";

const clip = {
  type: "video",
  meta: { backend: "local", mediaType: "video", description: "test", ref: "trim", inputs: {} },
  createDefinition: (inputs) => ({
    kind: "local",
    operation: "trim",
    mediaType: "video",
    inputs: { source: inputs.source.src, start: 0, duration: inputs.duration },
  }),
};

export default defineAnimatic(direction, {
  drafts: ({ draft }) => ({
    a: draft(["01"], () => asset("a", clip, { source: reference.footage, duration: ${firstLength} })),
    b: draft(["02"], ({ previous }) => asset("b", clip, { source: previous, duration: 1 })),
  }),
  timeline: ({ pendingShot }) => ({ shots: pendingShot("01").nextPendingShot("02") }),
});
`;

  it("continues a rerolled take from the newest take before it", async () => {
    const CUT = "animatic:draft.b#previous";
    const projectDir = await project(
      continued(3),
      DIRECTION_TS.replace("duration: 2, lineup: [] }", "duration: 3, lineup: [] }"),
    );
    await generate(projectDir);
    // The take runs 3s of footage that changes colour at 2s, and the next take runs 2s: its tail
    // changes colour a second in.
    const cut = (await takesOf(projectDir, CUT))[0]![1];
    expect(await detectSceneChanges(path.resolve(projectDir, cut.file!), 0.25, 1 / 30)).toEqual([
      expect.closeTo(1, 1),
    ]);

    // A different cut of the footage, so the new take is not the old one's bytes.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), continued(3.5));
    await run(["reroll", "animatic:draft.a"], projectDir);
    await run(["job", "wait"], projectDir);
    const plan = await run(["generate", "animatic", "--plan"], projectDir);
    expect(plan.stdout).toContain("animatic:draft.b: skip (already ready)");

    const { stdout } = await run(["reroll", "animatic:draft.b"], projectDir);
    expect(stdout).toContain(`${CUT}: pending`);
    await run(["job", "wait"], projectDir);

    // Both in one run: the cut is fresh until the take before lands, and is redone all the same.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), continued(3.2));
    const both = await run(["reroll", "animatic:draft.a", "animatic:draft.b"], projectDir);
    expect(both.stdout).toContain(`${CUT}: pending`);
    await run(["job", "wait"], projectDir);
    const swept = await run(["probe", "cuts", "animatic:draft"], projectDir);
    expect(swept.stdout).toContain("animatic:draft.a ");
    expect(swept.stdout).not.toContain(`${CUT} `);

    const state = (await StateManager.load(projectDir)).getState();
    const newest = (address: string) =>
      Object.values(state.assets[address]!.variants!).sort((x, y) =>
        x.createdAt < y.createdAt ? 1 : -1,
      )[0]!;
    expect(Object.keys(state.assets[CUT]!.variants!)).toHaveLength(3);
    expect(newest(CUT).inputFingerprints["animatic:draft.a"]).toBe(
      newest("animatic:draft.a").outputHash,
    );
  });

  it("recuts the frame from the newest take when its own `at` moves", async () => {
    const projectDir = await project(animaticWith({ shots: "drawn" }));
    await generate(projectDir);
    await fs.writeFile(
      path.join(projectDir, "animatic.tsx"),
      animaticWith({ shots: "drawn", at: 2.5 }),
    );
    const { stdout } = await run(["generate", "animatic", "--plan"], projectDir);
    expect(stdout).toMatch(new RegExp(`${FRAME.replaceAll(".", "\\.")}: (start|wait)`));
  });
});
