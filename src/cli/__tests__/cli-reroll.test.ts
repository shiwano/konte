import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JobManager } from "../../core/job-manager.js";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  ctx,
  useTempWorkspace,
  run,
  runCapture,
  initWorkspace,
  acceptDirection,
  writeWorkspaceConfig,
} from "./cli-fixtures.js";

// The record as plain JSON, so a test reads nested metadata without narrowing the union.
async function readJob(videoRoot: string, id: string): Promise<any> {
  return JSON.parse(JSON.stringify(await new JobManager(videoRoot).getJob(id)));
}

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("reroll command", () => {
  // A reference stage of offline (ffmpeg) building blocks: two independent images plus one that
  // consumes the first, so reroll runs end-to-end without a backend and `keyed` gives us a
  // downstream to test in-run pinning. They use `internalTestImage` rather than a shipped `local`
  // adapter because reroll refuses a deterministic asset — `derived` is the one that stays
  // deterministic, to exercise that refusal and the dependent cascade.
  const REROLL_REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage } from "konte";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latentA = asset("latentA", internalTestImage, { width: 64, height: 64 });
  const latentB = asset("latentB", internalTestImage, { width: 48, height: 48 });
  const keyed = asset("keyed", internalTestImage, { image: latentA, width: 32, height: 32 });
  const derived = asset("derived", adapters.imageResize, { image: latentA, width: 16, height: 16 });
  return { character, bgm, latentA, latentB, keyed, derived };
});
`;

  async function initRerollProject(): Promise<string> {
    const inited_rerollproj = await initWorkspace(path.join(ctx.dir, "rerollproj"));
    const projectDir = inited_rerollproj.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), REROLL_REFERENCE_TS);
    return projectDir;
  }

  // "  <address>: <status> → <variantId>" — the one line reroll prints per take it registered.
  type RerollJob = { address: string; status: string; variantId: string };
  const rerollJobs = (stdout: string): RerollJob[] =>
    [...stdout.matchAll(/^ {2}(\S+): (\S+) → (\S+)$/gm)].map((m) => ({
      address: m[1]!,
      status: m[2]!,
      variantId: m[3]!,
    }));
  const jobsByAddress = (stdout: string, address: string): RerollJob[] =>
    rerollJobs(stdout).filter((j) => j.address === address);

  // reroll is a spend entry point, so it passes the same gate — before a variant id is reserved
  // and a job written.
  const COMFY_REFERENCE_TS = `import { defineReference, asset, adapters, defineComfyAsset } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

const plateAdapter = defineComfyAsset({
  workflow: "plate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const latent = asset("latent", internalTestPlate, { width: 64, height: 64, color: "#ffffff" });
  const plate = asset("plate", plateAdapter, {});
  return { character, bgm, latent, plate };
});
`;

  async function initComfyRerollProject(name: string, comfyui: unknown): Promise<string> {
    const inited = await initWorkspace(path.join(ctx.dir, name));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), COMFY_REFERENCE_TS);
    await writeWorkspaceConfig(projectDir, { comfyui });
    return projectDir;
  }

  // Nothing may be reserved on the way to a refusal, whichever half of the gate refuses.
  async function expectNothingReserved(projectDir: string): Promise<void> {
    const state = JSON.parse(
      await fs.readFile(path.join(projectDir, "konte.state.json"), "utf-8"),
    ) as { assets?: Record<string, { variants?: Record<string, unknown> }> };
    expect(state.assets?.["reference:plate"]?.variants ?? {}).toEqual({});
  }

  it("refuses to reroll an asset whose backend this workspace has not configured", async () => {
    const projectDir = await initComfyRerollProject("rerollunconf", { url: "" });
    const { stderr } = await runCapture(["reroll", "reference:plate"], projectDir);
    expect(stderr).toContain("reference:plate");
    expect(stderr).toContain("comfyui.url");
    await expectNothingReserved(projectDir);
  });

  it("refuses to reroll a comfy asset whose header credential is unset", async () => {
    const inited = await initWorkspace(path.join(ctx.dir, "rerollauth"));
    const projectDir = inited.video;
    await fs.writeFile(path.join(projectDir, "reference.tsx"), COMFY_REFERENCE_TS);
    await writeWorkspaceConfig(projectDir, {
      comfyui: {
        url: "http://127.0.0.1:8188",
        headers: { Authorization: "Bearer ${KONTE_TEST_ABSENT_TOKEN}" },
        autoInstallModels: false,
        autoInstallNodes: false,
      },
    });

    const { stderr } = await runCapture(["reroll", "reference:plate"], projectDir);
    expect(stderr).toContain("KONTE_TEST_ABSENT_TOKEN");
    await expectNothingReserved(projectDir);
  });

  it("rerolls several addresses in one command", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentB"], projectDir);

    expect(
      rerollJobs(stdout)
        .map((j) => j.address)
        .sort(),
    ).toEqual(["reference:latentA", "reference:latentB"]);
  });

  // The outcome and the step share the LAST line: a caller piping through `tail -1` keeps both.
  it("lands the outcome and the step on one line", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentB"], projectDir);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "2 take(s) across 2 asset(s) — run `konte job wait`",
    );
  });

  it("applies --count to each listed address", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(
      ["reroll", "reference:latentA", "reference:latentB", "--count", "2"],
      projectDir,
    );

    expect(rerollJobs(stdout)).toHaveLength(4);
    expect(jobsByAddress(stdout, "reference:latentA")).toHaveLength(2);
    expect(jobsByAddress(stdout, "reference:latentB")).toHaveLength(2);
  });

  // A downstream listed alongside its upstream must build on the freshly rerolled upstream, not
  // an older accepted one — so its job pins to (and waits on) the new upstream variant.
  it("pins a listed downstream asset to the freshly rerolled upstream", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:keyed"], projectDir);
    const upstreamId = jobsByAddress(stdout, "reference:latentA")[0]!.variantId;
    const keyedId = jobsByAddress(stdout, "reference:keyed")[0]!.variantId;

    const job = await readJob(projectDir, keyedId);
    expect(job.dependsOnJobs).toContain(upstreamId);
    expect(job.metadata.pinnedDeps["reference:latentA"]).toBe(upstreamId);
  });

  it("waits on a dependency another run is still generating", async () => {
    const projectDir = await initRerollProject();
    const sm = await StateManager.load(projectDir);
    const inFlightId = sm.reserveVariantId("reference:latentA");
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: "reference:latentA",
      variantId: inFlightId,
      resolvedDeps: {},
      backendKind: "local",
    });

    const { stdout } = await run(["reroll", "reference:keyed"], projectDir);
    const keyed = jobsByAddress(stdout, "reference:keyed")[0]!;
    expect(keyed.status).toBe("pending");
    const job = await readJob(projectDir, keyed.variantId);
    expect(job.dependsOnAssets).toContain("reference:latentA");
  });

  it("refuses a dependency nothing will produce before creating any job", async () => {
    const projectDir = await initRerollProject();
    const { stderr } = await runCapture(
      ["reroll", "reference:latentB", "reference:keyed"],
      projectDir,
    );
    expect(stderr).toContain("DEPENDENCY_NOT_RESOLVED");
    expect(stderr).toContain("reference:keyed — reference:latentA");
    expect(await new JobManager(projectDir).listJobs()).toEqual([]);
  });

  it("dedupes a repeated address", async () => {
    const projectDir = await initRerollProject();
    const { stdout } = await run(["reroll", "reference:latentA", "reference:latentA"], projectDir);
    expect(rerollJobs(stdout)).toHaveLength(1);
  });

  // Rerolling an accepted asset is "redo it, review the new take", so the accept is dropped
  // (else the old variant would keep winning resolution and hide the reroll). It is gated:
  // a non-TTY run needs --yes; an asset with nothing accepted just proceeds.
  async function acceptFresh(projectDir: string, address: string): Promise<string> {
    const sm = await StateManager.load(projectDir);
    const vid = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![vid]!.file = `assets/${vid}.png`;
    sm.setAccepted(address, vid);
    await sm.save();
    return vid;
  }

  it("unaccepts an accepted asset when rerolled (with --yes)", async () => {
    const projectDir = await initRerollProject();
    const oldVid = await acceptFresh(projectDir, "reference:latentA");

    const { stdout } = await run(["reroll", "reference:latentA", "--yes"], projectDir);
    expect(rerollJobs(stdout)).toHaveLength(1);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBeNull();
    // The old variant is unaccepted, not deleted.
    expect(sm.getAssetState("reference:latentA").variants![oldVid]).toBeDefined();
  });

  it("refuses to reroll an accepted asset non-interactively without --yes", async () => {
    const projectDir = await initRerollProject();
    await acceptFresh(projectDir, "reference:latentA");

    await expect(run(["reroll", "reference:latentA"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    // The accept survived and no reroll was submitted.
    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).not.toBeNull();
    expect(Object.keys(sm.getAssetState("reference:latentA").variants!)).toHaveLength(1);
  });

  it("aborts and keeps the accept on --no", async () => {
    const projectDir = await initRerollProject();
    const oldVid = await acceptFresh(projectDir, "reference:latentA");

    const { stdout } = await run(["reroll", "reference:latentA", "--no"], projectDir);
    expect(stdout).toContain("Aborted.");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBe(oldVid);
  });

  it("stops --with-dependents at an accepted dependent and unaccepts only the named asset", async () => {
    const projectDir = await initRerollProject();
    await acceptFresh(projectDir, "reference:latentA");
    const keyed = await acceptFresh(projectDir, "reference:keyed");

    const { stdout } = await run(
      ["reroll", "reference:latentA", "--with-dependents", "--yes"],
      projectDir,
    );
    expect(jobsByAddress(stdout, "reference:keyed")).toHaveLength(0);
    expect(stdout).toContain("will be unaccepted so the new take becomes the reviewed one");
    expect(stdout).toContain("reference:latentA.");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBeNull();
    expect(sm.getAcceptedVariant("reference:keyed")).toBe(keyed);
  });

  it("prints what --yes unaccepts", async () => {
    const projectDir = await initRerollProject();
    await acceptFresh(projectDir, "reference:latentA");

    const { stdout } = await run(["reroll", "reference:latentA", "--yes"], projectDir);
    expect(stdout).toContain("1 accepted variant(s) will be unaccepted");
    expect(stdout).toContain("reference:latentA");
  });

  it("skips an accepted asset reached through a scope", async () => {
    const projectDir = await initRerollProject();
    const latentA = await acceptFresh(projectDir, "reference:latentA");
    await acceptFresh(projectDir, "reference:keyed");

    const { stdout } = await run(["reroll", "reference", "--yes"], projectDir);
    expect(rerollJobs(stdout).map((j) => j.address)).toEqual(["reference:latentB"]);
    expect(stdout).not.toContain("will be unaccepted");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:latentA")).toBe(latentA);
  });

  // The accept is dropped only after the reroll job is created; an asset whose submit fails
  // synchronously produced no reroll, so its accept survives (old take stays accepted/resolved).
  it("keeps the accept when the reroll submit fails", async () => {
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
    const oldVid = await acceptFresh(projectDir, "reference:badResize");

    const err = (await run(["reroll", "reference:badResize", "--yes"], projectDir).catch(
      (e) => e,
    )) as { code: number; stdout: string };
    expect(err.code).toBe(1);
    expect(err.stdout).toContain("1 failed");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:badResize")).toBe(oldVid);
  });

  it("fails a listed dependent without a job when its upstream's submit fails", async () => {
    const projectDir = await initRerollProject();
    const badReference = REROLL_REFERENCE_TS.replace(
      "  return { character, bgm, latentA, latentB, keyed, derived };",
      `  const badSrc = asset("badSrc", adapters.imageFile, { path: "assets/files/bad.png" });
  const badResize = asset("badResize", internalTestImage, { image: badSrc, width: 32, height: 32 });
  const badChild = asset("badChild", internalTestImage, { image: badResize, width: 16, height: 16 });
  return { character, bgm, latentA, latentB, keyed, derived, badSrc, badResize, badChild };`,
    );
    await fs.writeFile(path.join(projectDir, "reference.tsx"), badReference);
    await fs.mkdir(path.join(projectDir, "assets", "files"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "assets", "files", "bad.png"), "not a real png");
    const childVid = await acceptFresh(projectDir, "reference:badChild");

    const err = (await run(
      ["reroll", "reference:badResize", "reference:badChild", "--count", "2", "--yes"],
      projectDir,
    ).catch((e) => e)) as { code: number; stdout: string };
    expect(err.code).toBe(1);
    expect(jobsByAddress(err.stdout, "reference:badChild")).toEqual([]);
    expect(err.stdout).toContain("reference:badChild  Dependency failed");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:badChild")).toBe(childVid);
  });

  // Validation runs over every listed address before any job is created, so one bad address
  // aborts the whole command rather than half-rerolling.
  it("rejects a file asset listed among rerollable ones", async () => {
    const projectDir = await initRerollProject();
    await expect(
      run(["reroll", "reference:latentA", "reference:character"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_ASSET_TYPE") });
  });

  // A deterministic op has no second take to pick, so reroll names the command that does replace it
  // instead.
  it("refuses a deterministic asset", async () => {
    const projectDir = await initRerollProject();
    const err = (await run(["reroll", "reference:derived"], projectDir).catch((e) => e)) as {
      stderr: string;
    };
    expect(err.stderr).toContain("DETERMINISTIC_NOT_REROLLABLE");
    expect(err.stderr).toContain("konte generate reference");
  });

  // ...but a cascade still rebuilds one. Its accept is dropped behind the same confirmation as any
  // other.
  it("drops a collected deterministic dependent's accept after confirmation", async () => {
    const projectDir = await initRerollProject();
    await acceptFresh(projectDir, "reference:derived");

    await expect(
      run(["reroll", "reference:latentA", "--with-dependents"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("CONFIRMATION_REQUIRED") });

    const { stdout } = await run(
      ["reroll", "reference:latentA", "--with-dependents", "--yes"],
      projectDir,
    );
    expect(jobsByAddress(stdout, "reference:derived")).toHaveLength(1);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant("reference:derived")).toBeNull();
  });

  // A synchronous submit failure (here: ffmpeg choking on a non-image "bad.png") must be surfaced
  // in the output AND set a non-zero exit — mirroring `generate`, not silently exiting 0.
  it("surfaces a submit failure and exits non-zero", async () => {
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

    const err = (await run(["reroll", "reference:badResize"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    expect(err.code).toBe(1);
    expect(err.stdout).toContain("Failed:");
    expect(err.stdout).toMatch(/^ {2}reference:badResize {2}\S/m);
    expect(err.stdout).toContain("1 failed");
  });

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
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "the hero beat", setup: "front", duration: 3 , lineup: [] }],
    waivers: {
      "missing-beat_ordinary": "single-shot offline fixture",
      "missing-beat_disruption": "single-shot offline fixture",
      "missing-beat_pressure": "single-shot offline fixture",
      "unearned-payoff_hero": "single-shot offline fixture",
      "location-unreferenced_studio": "single-shot offline fixture has no reference stage",
      "setup-unconsumed_front": "fixture board is anchored on nothing",
    },
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
    // chain reroll is an iteration on a reviewed board, not a way around its review. Rerolling
    // then drops this accept (hence -y) so the fresh chain goes back through review.
    const address = "animatic:shot.01.keyframe";
    const sm = await StateManager.load(projectDir);
    const acceptedId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![acceptedId]!.file = "assets/kf.png";
    sm.setAccepted(address, acceptedId);
    await sm.save();
    const { stdout } = await run(
      ["reroll", "animatic:shot.01.keyframe", "video:shot.01.motion", "-y"],
      projectDir,
    );
    const keyframeId = jobsByAddress(stdout, "animatic:shot.01.keyframe")[0]!.variantId;
    const motionId = jobsByAddress(stdout, "video:shot.01.motion")[0]!.variantId;

    const job = await readJob(projectDir, motionId);
    expect(job.dependsOnJobs).toContain(keyframeId);
    expect(job.metadata.pinnedDeps["animatic:shot.01.keyframe"]).toBe(keyframeId);
  });
});
