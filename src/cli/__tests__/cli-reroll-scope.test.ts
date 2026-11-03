import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  ctx,
  useTempWorkspace,
  run,
  runCapture,
  initWorkspace,
  acceptDirection,
} from "./cli-fixtures.js";

import {
  readJob,
  REROLL_REFERENCE_TS,
  initRerollProject,
  rerollJobs,
  jobsByAddress,
} from "./reroll-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("reroll command", () => {
  // An address-scope sweeps the assets a spend may touch and drops the rest in silence: `character`
  // and `bgm` are files, `derived` is deterministic. Naming any of those three still refuses.
  it("sweeps every rerollable asset under a stage scope", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference", "--yes"], projectDir);
    expect([...new Set(rerollJobs(stdout).map((j) => j.address))].sort()).toEqual([
      "reference:keyed",
      "reference:latentA",
      "reference:latentB",
    ]);
  });

  it("refuses a scope that matched no rerollable asset", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(["reroll", "video:shot.99", "--yes"], projectDir);
    expect(stderr).toContain("No rerollable asset under");
  });

  // A sweep is priced before it spends, so a non-TTY run without --yes fails rather than hanging or
  // silently starting a hundred jobs.
  it("requires --yes to sweep a scope with no TTY", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(["reroll", "reference"], projectDir);
    expect(stderr).toContain("--yes");
    expect(stderr).toContain("take(s) will be generated");
  });

  it("refuses a run that names no target and no --failed", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(["reroll"], projectDir);
    expect(stderr).toContain("--failed");
  });

  // A named address answers for itself whatever else narrows the run — otherwise --failed turns a
  // refusal into a silent "nothing to do".
  it("still refuses a named unrerollable address under --failed", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(
      ["reroll", "reference:character", "--failed", "--yes"],
      projectDir,
    );
    expect(stderr).toContain("file assets cannot be rerolled");
  });

  it("refuses a scope that matched nothing even when another target did", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(
      ["reroll", "reference", "video:shot.99", "--yes"],
      projectDir,
    );
    expect(stderr).toContain('"video:shot.99"');
  });

  // The no-op a retry loop asks for: a reason on stdout and a zero exit, not silence.
  it("says so and exits 0 when --failed has nothing to retry", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "--failed", "--yes"], projectDir);
    expect(stdout).toContain("Nothing to reroll: no target has a dead or failed take");
    expect(rerollJobs(stdout)).toEqual([]);
  });

  // The P0 this flag exists for: one command retries what `status` reports under Problems, without
  // the caller extracting addresses from its text.
  it("--failed retries only the address whose take failed", async () => {
    const projectDir = await initRerollProject();
    const badReference = REROLL_REFERENCE_TS.replace(
      "  return { character, bgm, latentA, latentB, keyed, derived };",
      `  const badSrc = asset("badSrc", adapters.imageFile, { path: "assets/files/bad.png" });
  const badResize = asset("badResize", internalTestImage, { image: badSrc, width: 32, height: 32 });
  return { character, bgm, latentA, latentB, keyed, derived, badSrc, badResize };`,
    );
    await fs.writeFile(path.join(projectDir, "reference.tsx"), badReference);
    await fs.mkdir(path.join(projectDir, "assets", "files"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "assets", "files", "bad.png"), "not a real png");
    await run(["reroll", "reference:badResize"], projectDir).catch(() => undefined);
    await run(["job", "wait"], projectDir).catch(() => undefined);

    const retry = (await run(["reroll", "--failed", "--yes"], projectDir).catch((e) => e)) as {
      stdout: string;
    };
    expect([...new Set(rerollJobs(retry.stdout).map((j) => j.address))]).toEqual([
      "reference:badResize",
    ]);
  });

  // A minimal single-shot direction whose lens `before` beats are waived, so the direction gate
  // passes without any characters — enough to exercise the cross-stage (video→animatic) pin.
  const CROSS_DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en" },
  waivers: {
    "missing-role_ordinary": "single-shot offline fixture",
    "missing-role_disruption": "single-shot offline fixture",
    "missing-role_pressure": "single-shot offline fixture",
    "unearned-payoff_hero": "single-shot offline fixture",
    "location-unreferenced_studio": "single-shot offline fixture has no reference stage",
    "setup-unconsumed_front": "fixture board is anchored on nothing",
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "the hero beat", setup: "front", duration: 3 , lineup: [] }],
  },
});
`;

  const CROSS_ANIMATIC_TS = `import { defineAnimatic, asset, Composition, Panel } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, {
  timeline: ({ shot }) =>
    ({ shots: shot("01", () => {
        const keyframe = asset("keyframe", internalTestImage, {
          width: 64,
          height: 64,
        });
        return <Composition>
<Panel src={keyframe} blocking="the subject leans in" camera="fixed" />
</Composition>;
    }) }),
});
`;

  // \`motion\` consumes the animatic keyframe — the cross-stage edge.
  const CROSS_VIDEO_TSX = `import { defineVideo, Composition, Video, asset } from "konte";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";
import direction from "./direction";
import animatic from "./animatic";

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
          const motion = asset("motion", internalTestImage, {
            image: animatic.shot("01").image("keyframe"),
            width: 48,
            height: 48,
          });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
      }),
  }),
});
`;

  async function initCrossStageRerollProject(): Promise<string> {
    const inited_crossproj = await initWorkspace(path.join(ctx.dir, "crossproj"));
    const projectDir = inited_crossproj.video;
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_DIRECTION_TS);
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), CROSS_ANIMATIC_TS);
    await fs.writeFile(path.join(projectDir, "video.tsx"), CROSS_VIDEO_TSX);
    await acceptDirection(projectDir);
    return projectDir;
  }

  // A video asset listed alongside its animatic upstream must pin to (and wait on) the fresh
  // upstream variant, across the stage boundary.
  it("pins a video asset to a freshly rerolled animatic upstream", async () => {
    const projectDir = await initCrossStageRerollProject();
    // The animatic gate requires the consumed board to be accepted before any video spend — a
    // chain reroll is an iteration on a reviewed board, not a way around its review.
    const address = "animatic:shot.01.keyframe";
    const sm = await StateManager.load(projectDir);
    const acceptedId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![acceptedId]!.file = "assets/kf.png";
    sm.setAccepted(address, acceptedId);
    await sm.save();
    const { stdout } = await run(
      ["reroll", "animatic:shot.01.keyframe", "video:shot.01.motion"],
      projectDir,
    );
    const keyframeId = jobsByAddress(stdout, "animatic:shot.01.keyframe")[0]!.variantId;
    const motionId = jobsByAddress(stdout, "video:shot.01.motion")[0]!.variantId;

    const job = await readJob(projectDir, motionId);
    expect(job.dependsOnJobs).toContain(keyframeId);
    expect(job.metadata.pinnedDeps["animatic:shot.01.keyframe"]).toBe(keyframeId);
  });
});
