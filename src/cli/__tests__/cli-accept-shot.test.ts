import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../../core/job-manager.js";
import { StateManager } from "../../core/state/manager.js";
import {
  ctx,
  useTempWorkspace,
  acceptDirection,
  initWithTestVideo,
  initWithChainedShotsVideo,
  initWithCrossStageStemVideo,
  initWithDepsVideo,
  CROSS_STAGE_DIRECTION_TS,
  writeSilentWav,
  initWorkspace,
  TEST_VIDEO_TSX,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("accept command (shot scope)", () => {
  let projectDir: string;
  let motionVid: string;
  const motionAddr = "video:shot.01.motion";
  const compAddr = "video:shot.01#composition";
  const stemAddr = "video:shot.01#stem";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
    const sm = await StateManager.load(projectDir);
    motionVid = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![motionVid]!.file = "/tmp/motion.mp4";
    sm.getAssetState(motionAddr).variants![motionVid]!.outputHash = "motion-1";
    const voiceAddr = "video:shot.01.voice";
    const voiceVid = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![voiceVid]!.file = "/tmp/voice.wav";
    sm.getAssetState(voiceAddr).variants![voiceVid]!.outputHash = "voice-1";
    await sm.save();
  });

  it("accepts the shot's composition and stem", async () => {
    const { stdout } = await run(["accept", "video:shot.01", "--yes"], projectDir);
    expect([...stdout.matchAll(/^Accepted: (\S+) → /gm)].map((m) => m[1]).sort()).toEqual([
      compAddr,
      stemAddr,
    ]);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).not.toBeNull();
    expect(after.getAcceptedVariant(stemAddr)).not.toBeNull();
  });

  it("renders the composition from the take named beside it", async () => {
    const sm = await StateManager.load(projectDir);
    const newer = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![newer]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![newer]!.outputHash = "motion-2";
    await sm.save();

    await run(["accept", "video:shot.01", motionVid, "--yes"], projectDir);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBe(motionVid);
    const comp = after.getAcceptedVariant(compAddr)!;
    expect(after.getAssetState(compAddr).variants![comp]!.keptInputs).toBeUndefined();
    expect(after.variantStaleness(compAddr, comp)?.inputStale).toBe(false);
  });

  it("refuses a composition named by its id beside a take that moves what it shows", async () => {
    await run(["accept", compAddr, "--yes"], projectDir);
    const sm = await StateManager.load(projectDir);
    const comp = sm.getAcceptedVariant(compAddr)!;
    const newer = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![newer]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![newer]!.outputHash = "motion-2";
    await sm.save();

    await expect(run(["accept", comp, newer, "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/TARGETS_CONFLICT.*name video:shot\.01#composition instead/s),
    });
    expect((await StateManager.load(projectDir)).getAcceptedVariant(motionAddr)).toBe(motionVid);
  });

  it("accepts the overlay after the shot accepts under it", async () => {
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_TSX.replace("import { Composition,", "import { Composition, Subtitle,").replace(
        "    }),\n  }),\n});",
        '    }),\n    overlay: () => <Composition><Subtitle entries={[{ start: 1, end: 3, text: "hi" }]} /></Composition>,\n  }),\n});',
      ),
    );
    const { stdout } = await run(["accept", "video", "--yes"], projectDir);
    expect([...stdout.matchAll(/^Accepted: (\S+) → /gm)].map((m) => m[1]).at(-1)).toBe(
      "video:timeline#overlay",
    );
  });

  it("leaves out a shot over an accept with a take awaiting a verdict beside it", async () => {
    const sm = await StateManager.load(projectDir);
    sm.setAccepted(motionAddr, motionVid);
    const rerolled = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![rerolled]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![rerolled]!.outputHash = "motion-2";
    await sm.save();

    await expect(run(["accept", "video", "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `video:shot.01 — ${motionAddr}: ${rerolled} await a verdict beside its accept`,
      ),
    });
    expect((await StateManager.load(projectDir)).getAcceptedVariant(compAddr)).toBeNull();
  });

  it("leaves out an overlay whose own takes are not ready, accepting the shots", async () => {
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_TSX.replace("import { Composition,", "import { Composition, Image,").replace(
        "    }),\n  }),\n});",
        '    }),\n    overlay: () => <Composition><Image src="__konte:reference:studio__" /></Composition>,\n  }),\n});',
      ),
    );
    const { stdout } = await run(["accept", "video", "--yes"], projectDir);
    expect(stdout).toContain("Left unaccepted: video:timeline#overlay — reference:studio:");
    expect((await StateManager.load(projectDir)).getAcceptedVariant(compAddr)).not.toBeNull();
  });

  it("leaves out a shot over a stale accept with a take drawn beside it", async () => {
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(motionAddr).variants![motionVid]!.definitionHash = "an-older-definition";
    sm.setAccepted(motionAddr, motionVid);
    const rerolled = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![rerolled]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![rerolled]!.outputHash = "motion-2";
    await sm.save();

    await expect(run(["accept", "video", "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `video:shot.01 — ${motionAddr}: ${rerolled} await a verdict beside its accept`,
      ),
    });
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).toBeNull();
    expect(after.getAssetState(motionAddr).variants![rerolled]!.status).toBe("none");
  });

  it("leaves out a reference card whose accept has a take awaiting a verdict beside it", async () => {
    const studio = "reference:studio";
    const sm = await StateManager.load(projectDir);
    const first = sm.reserveVariantId(studio);
    sm.getAssetState(studio).variants![first]!.file = "/tmp/studio1.png";
    sm.setAccepted(studio, first);
    const rerolled = sm.reserveVariantId(studio);
    sm.getAssetState(studio).variants![rerolled]!.file = "/tmp/studio2.png";
    await sm.save();

    const { stdout } = await run(["accept", "reference", "--yes"], projectDir);
    expect(stdout).toContain(
      `Left unaccepted: ${studio} — ${rerolled} await a verdict beside its accept`,
    );
    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(studio).variants![rerolled]!.status).toBe("none");
  });

  it("refuses the address of a leaf beside its own variant id", async () => {
    await run(["accept", compAddr, "--yes"], projectDir);
    const comp = (await StateManager.load(projectDir)).getAcceptedVariant(compAddr)!;
    await expect(run(["accept", compAddr, comp, "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("TARGETS_CONFLICT"),
    });
  });

  it("accepts every ready shot of a stage", async () => {
    await run(["accept", "video", "--yes"], projectDir);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).not.toBeNull();
    expect(after.getAcceptedVariant(stemAddr)).not.toBeNull();
    expect(after.getAcceptedVariant(motionAddr)).toBe(motionVid);
  });

  it("releases the stem a shot stopped mixing into", async () => {
    const sm = await StateManager.load(projectDir);
    const stemVid = sm.reserveVariantId(stemAddr);
    sm.getAssetState(stemAddr).variants![stemVid]!.file = "stem.json";
    sm.setAccepted(stemAddr, stemVid);
    await sm.save();
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_TSX.replace(
        '      const voice = asset("voice", ttsComfy, { text: "hello" });\n',
        "",
      ).replace("<Audio src={voice} />", ""),
    );

    const { stdout } = await run(["accept", "video", "--yes"], projectDir);
    expect(stdout).toContain(`Unaccepted: ${stemAddr} → ${stemVid}`);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(stemAddr)).toBeNull();
    expect(after.getAcceptedVariant(compAddr)).not.toBeNull();
  });

  it("clears a stage's accepted leaves with --off", async () => {
    await run(["accept", "video", "--yes"], projectDir);
    const { stdout } = await run(["accept", "video", "--off", "--yes"], projectDir);
    expect(stdout.match(/^Unaccepted: /gm)).toHaveLength(2);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).toBeNull();
    expect(after.getAcceptedVariant(stemAddr)).toBeNull();
  });

  it("undoes the leaves it rendered when another target does not resolve", async () => {
    await expect(
      run(["accept", "video:shot.01", "video:shot.99.motion", "--yes"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VARIANT_NOT_FOUND") });
    const after = await StateManager.load(projectDir);
    expect(after.tryGetAssetState(compAddr)?.variants ?? {}).toEqual({});
    expect(after.tryGetAssetState(stemAddr)?.variants ?? {}).toEqual({});
  });

  it("rejects a shot with nothing to accept", async () => {
    await expect(run(["accept", "video:shot.99"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ADDRESS_NOT_FOUND"),
    });
  });

  it("clears the shot's accepted leaves with --off", async () => {
    await run(["accept", "video:shot.01", "--yes"], projectDir);
    const { stdout } = await run(["accept", "video:shot.01", "--off", "--yes"], projectDir);
    expect(stdout.match(/^Unaccepted: /gm)).toHaveLength(2);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).toBeNull();
    expect(after.getAcceptedVariant(stemAddr)).toBeNull();
  });

  it("refuses --off on a shot with no accepted leaf", async () => {
    await expect(run(["accept", "video:shot.01", "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_ACCEPTED"),
    });
  });
});

describe("accept command (several leaves)", () => {
  it("undoes the leaves it rendered when a later one cannot be", async () => {
    const projectDir = await initWithTestVideo();
    const sm = await StateManager.load(projectDir);
    const voiceAddr = "video:shot.01.voice";
    const voiceVid = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![voiceVid]!.file = "/tmp/voice.wav";
    await sm.save();

    // The stem needs only the voice; the composition also needs the motion, which has no take.
    await expect(
      run(["accept", "video:shot.01#stem", "video:shot.01#composition", "--yes"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VARIANT_NOT_FOUND") });
    const after = await StateManager.load(projectDir);
    expect(after.tryGetAssetState("video:shot.01#stem")?.variants ?? {}).toEqual({});
  });
});

describe("accept command (the board's stem)", () => {
  it("mixes and accepts animatic:shot.<id>#stem by address, reusing it on a re-accept", async () => {
    const projectDir = await initWithCrossStageStemVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), CROSS_STAGE_DIRECTION_TS);
    await acceptDirection(projectDir);
    const keyframe = "animatic:shot.01.keyframe";
    const voice = "animatic:shot.01.voice";
    const stem = "animatic:shot.01#stem";
    await writeSilentWav(path.join(projectDir, "assets", "voice.wav"));
    const sm = await StateManager.load(projectDir);
    const kfId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![kfId]!.file = "assets/kf.png";
    sm.getAssetState(keyframe).variants![kfId]!.outputHash = "kf";
    const voiceId = sm.reserveVariantId(voice);
    sm.getAssetState(voice).variants![voiceId]!.file = "assets/voice.wav";
    sm.getAssetState(voice).variants![voiceId]!.outputHash = "voice-1";
    sm.setAccepted(keyframe, kfId);
    sm.setAccepted(voice, voiceId);
    await sm.save();

    const { stdout } = await run(["accept", stem, "--yes"], projectDir);
    const firstId = stdout.match(new RegExp(`^Accepted: ${stem} → (v-\\S+)`, "m"))![1]!;
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(stem)).toBe(firstId);
    const v = after.getAssetState(stem).variants![firstId]!;
    expect(v.file).toMatch(/stem\.wav$/);
    await fs.access(path.join(projectDir, v.file!));
    expect(v.media?.kind).toBe("audio");
    expect(v.inputFingerprints).toEqual({ [voice]: "voice-1" });

    const again = await run(["accept", stem, "--yes"], projectDir);
    expect(again.stdout).toContain(`Accepted: ${stem} → ${firstId}`);
    expect(
      Object.keys((await StateManager.load(projectDir)).getAssetState(stem).variants!),
    ).toEqual([firstId]);
  });
});

describe("accept command (cascade upstream)", () => {
  it("accepts the unaccepted dependency the accepted variant consumed", async () => {
    const projectDir = await initWithDepsVideo();
    const motionAddr = "video:shot.01.motion";
    const finalAddr = "video:shot.01.final";

    const sm = await StateManager.load(projectDir);
    const motionVid = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![motionVid]!.file = "motion.mp4";
    const finalVid = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![finalVid]!.file = "final.mp4";
    await sm.save();

    const jm = new JobManager(projectDir);
    await jm.createJob({
      address: finalAddr,
      variantId: finalVid,
      resolvedDeps: { "video:shot.01.motion": "motion.mp4" },
      backendKind: "comfy",
    });

    const { stdout } = await run(["accept", finalVid, "--verbose"], projectDir);
    expect(stdout).toContain(motionAddr);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBe(motionVid);
  });

  // A materialized leaf's cascade signs off what the leaf SHOWS, resolved now — so re-accepting one
  // that is already accepted is not a no-op: it is how a take re-picked under it (a panel rerolled
  // under an accepted animatic, whose fingerprints no longer cover the board) gets signed off.
  it("re-signs the takes a leaf shows even when the leaf's own accept does not move", async () => {
    const projectDir = await initWithTestVideo();
    const motionAddr = "video:shot.01.motion";
    const compAddr = "video:shot.01#composition";

    const sm = await StateManager.load(projectDir);
    const motionVid = sm.reserveVariantId(motionAddr);
    const motion = sm.getAssetState(motionAddr).variants![motionVid]!;
    motion.file = "motion.mp4";
    motion.outputHash = "motion-1";
    sm.setAccepted(motionAddr, motionVid);
    // The shot's `<Audio>` take: the composition renders it too, so the leaf is unbuildable without
    // one. It rides the stem's accept, never the composition's cascade.
    const voiceAddr = "video:shot.01.voice";
    const voiceVid = sm.reserveVariantId(voiceAddr);
    const voice = sm.getAssetState(voiceAddr).variants![voiceVid]!;
    voice.file = "voice.wav";
    voice.outputHash = "voice-1";
    sm.setAccepted(voiceAddr, voiceVid);
    await sm.save();

    await run(["accept", compAddr, "--yes"], projectDir);
    const compVid = (await StateManager.load(projectDir)).getAcceptedVariant(compAddr);
    expect(compVid).toBeTruthy();

    // The take stops being accepted (what a reroll of it leaves behind) while still resolving — so
    // the leaf renders to the same variant and its own accept has nowhere to move.
    await StateManager.withLock(projectDir, async (m) => m.setUnaccepted(motionAddr, motionVid));

    const { stdout } = await run(["accept", compAddr, "--yes", "--verbose"], projectDir);
    expect(stdout).toContain(`Accepted: ${compAddr} → ${compVid}`);
    expect(stdout).toMatch(
      new RegExp(
        `^Also accepted \\(consumed dependencies\\): \\d+\\n(?: {2}.*\\n)*? {2}${motionAddr}$`,
        "m",
      ),
    );
    expect((await StateManager.load(projectDir)).getAcceptedVariant(motionAddr)).toBe(motionVid);
  });

  // Consent is owed to the stale set this run would propagate, not to the accept having moved: a
  // leaf's re-accept cascades, and a cascaded accept can restale a sibling consumer of the dep it
  // signs. Asking only when the accept itself changed would commit that silently.
  it("asks before a re-accept's cascade propagates stale", async () => {
    const projectDir = await initWithChainedShotsVideo();
    const motionAddr = "video:shot.01.motion";
    const enhancedAddr = "video:shot.02.enhanced";
    const compAddr = "video:shot.01#composition";

    const sm = await StateManager.load(projectDir);
    const motionVid = sm.reserveVariantId(motionAddr);
    const motion = sm.getAssetState(motionAddr).variants![motionVid]!;
    motion.file = "motion.mp4";
    motion.outputHash = "motion-1";
    // The consumer that goes stale, in the NEXT shot: a shot's own composition cannot be built while
    // any asset of that shot is stale, so a sibling inside shot 01 would block the accept instead.
    const enhancedVid = sm.reserveVariantId(enhancedAddr);
    const enhanced = sm.getAssetState(enhancedAddr).variants![enhancedVid]!;
    enhanced.file = "enhanced.mp4";
    enhanced.inputFingerprints = { [motionAddr]: "motion-old" };
    sm.setAccepted(enhancedAddr, enhancedVid);
    await sm.save();

    await run(["accept", compAddr, "--yes"], projectDir);
    await StateManager.withLock(projectDir, async (m) => m.setUnaccepted(motionAddr, motionVid));

    // Same leaf variant, so the accept itself cannot move — but the cascade re-signs `motion`, and
    // that is a stale propagation nobody consented to.
    await expect(run(["accept", compAddr], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });
    expect((await StateManager.load(projectDir)).getAcceptedVariant(motionAddr)).toBeNull();
  });
});

describe("accept command (several targets)", () => {
  const motionAddr = "video:shot.01.motion";
  const finalAddr = "video:shot.01.final";
  let projectDir: string;
  let m1: string;
  let m2: string;
  let finalVid: string;

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
    const sm = await StateManager.load(projectDir);
    m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "motion1.mp4";
    m2 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m2]!.file = "motion2.mp4";
    finalVid = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![finalVid]!.file = "final.mp4";
    await sm.save();
    await new JobManager(projectDir).createJob({
      address: finalAddr,
      variantId: finalVid,
      resolvedDeps: { [motionAddr]: "motion1.mp4" },
      backendKind: "comfy",
    });
  });

  // Named downstream first: the final's cascade would sign off the motion it consumed, unless the
  // named motion lands before it.
  it("accepts every named take, dependencies first", async () => {
    const { stdout } = await run(["accept", finalVid, m2, "--yes"], projectDir);
    expect([...stdout.matchAll(/^Accepted: (\S+) → /gm)].map((m) => m[1])).toEqual([
      motionAddr,
      finalAddr,
    ]);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBe(m2);
    expect(after.getAcceptedVariant(finalAddr)).toBe(finalVid);
    expect(after.getAssetState(motionAddr).variants![m1]!.status).toBe("dismissed");
  });

  it("refuses two takes of one address, deciding nothing", async () => {
    await expect(run(["accept", m1, m2, "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("TARGETS_CONFLICT"),
    });
    expect((await StateManager.load(projectDir)).getAcceptedVariant(motionAddr)).toBeNull();
  });

  it("accepts nothing when one target does not resolve", async () => {
    await expect(run(["accept", m2, "v-missing", "--yes"], projectDir)).rejects.toThrow();
    expect((await StateManager.load(projectDir)).getAcceptedVariant(motionAddr)).toBeNull();
  });

  it("accepts a composition beside a take it does not render", async () => {
    await run(["accept", "video:shot.01#composition", m2, "--yes"], projectDir);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant("video:shot.01#composition")).not.toBeNull();
    expect(after.getAcceptedVariant(motionAddr)).toBe(m2);
  });

  it("refuses the direction beside another target", async () => {
    await expect(run(["accept", "direction", m2], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("TARGETS_CONFLICT"),
    });
  });

  it("clears several accepts with --off", async () => {
    const sm = await StateManager.load(projectDir);
    sm.setAccepted(motionAddr, m2);
    sm.setAccepted(finalAddr, finalVid);
    await sm.save();

    const { stdout } = await run(["accept", m2, finalVid, "--off", "--yes"], projectDir);
    expect(stdout.match(/^Unaccepted: /gm)).toHaveLength(2);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBeNull();
    expect(after.getAcceptedVariant(finalAddr)).toBeNull();
  });
});

describe("accept command (deterministic assets)", () => {
  // `source` and `card` have one outcome; `derived` stands in for an AI asset.
  const REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";
// @ts-expect-error konte's own fixture adapter — deliberately outside the workspace type surface
import { internalTestImage, internalTestPlate } from "konte";

export default defineReference(direction, { references: () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const source = asset("source", internalTestPlate, { width: 64, height: 64, color: "#ff0000" });
  const derived = asset("derived", internalTestImage, { image: source, width: 32, height: 32 });
  const card = asset("card", adapters.jsxImage, {
    width: 64,
    height: 64,
    build: () => <h1>title</h1>,
  });
  return { character, bgm, source, derived, card };
} });
`;

  async function initProject(): Promise<{
    dir: string;
    sourceVid: string;
    derivedVid: string;
    cardVid: string;
  }> {
    const inited = await initWorkspace(path.join(ctx.dir, `detproj-${Math.random()}`));
    const dir = inited.video;
    await fs.writeFile(path.join(dir, "reference.tsx"), REFERENCE_TS);

    const sm = await StateManager.load(dir);
    const sourceVid = sm.reserveVariantId("reference:source");
    sm.getAssetState("reference:source").variants![sourceVid]!.file = "source.png";
    const derivedVid = sm.reserveVariantId("reference:derived");
    sm.getAssetState("reference:derived").variants![derivedVid]!.file = "derived.png";
    const cardVid = sm.reserveVariantId("reference:card");
    sm.getAssetState("reference:card").variants![cardVid]!.file = "card.png";
    await sm.save();
    return { dir, sourceVid, derivedVid, cardVid };
  }

  it("accepts and clears a deterministic take", async () => {
    const { dir, cardVid } = await initProject();

    await run(["accept", cardVid, "--yes"], dir);
    expect((await StateManager.load(dir)).getAcceptedVariant("reference:card")).toBe(cardVid);

    await run(["accept", cardVid, "--off", "--yes"], dir);
    expect((await StateManager.load(dir)).getAcceptedVariant("reference:card")).toBeNull();
  });

  it("refuses to dismiss one", async () => {
    const { dir, cardVid } = await initProject();

    await expect(run(["dismiss", cardVid, "--yes"], dir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DETERMINISTIC_NOT_DISMISSABLE"),
    });
  });

  it("accepts a deterministic dep a cascade reaches", async () => {
    const { dir, sourceVid, derivedVid } = await initProject();
    const jm = new JobManager(dir);
    await jm.createJob({
      address: "reference:derived",
      variantId: derivedVid,
      resolvedDeps: { "reference:source": "source.png" },
      backendKind: "local",
    });

    const { stdout } = await run(["accept", derivedVid, "--yes", "--verbose"], dir);
    expect(stdout).toContain("reference:source");

    const sm = await StateManager.load(dir);
    const source = sm.getAssetState("reference:source").variants![sourceVid]!;
    expect(source.status).toBe("accepted");
    expect(sm.getAcceptedVariant("reference:derived")).toBe(derivedVid);
  });
});
