import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
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
  initWithCrossStageVideo,
  initWithDepsVideo,
  CROSS_STAGE_DIRECTION_TS,
  writeSilentWav,
  initWorkspace,
  TEST_EMPTY_ANIMATIC_TSX,
  TEST_VIDEO_WITH_DEPS_TSX,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

// A `--verbose` address block: "<title>: <n>" followed by one indented address per line.
function addressesUnder(stdout: string, title: string): string[] {
  const at = stdout.indexOf(`${title}: `);
  if (at === -1) return [];
  const lines = stdout.slice(at).split("\n").slice(1);
  const end = lines.findIndex((line) => !line.startsWith("  "));
  return lines.slice(0, end === -1 ? lines.length : end).map((line) => line.trim());
}

const directionPartsAccepted = (stdout: string): string[] =>
  addressesUnder(stdout, "Also accepted (direction)");

interface DirectionPart {
  address: string;
  section: string;
  status: string;
}

// `konte inspect direction`'s listing read back: the acceptance line, every part under the section
// heading it was printed beneath, and the orphan block below them.
async function inspectDirection(projectDir: string): Promise<{
  acceptance: { status: string; blocking: number; total: number };
  parts: DirectionPart[];
  orphans: DirectionPart[];
}> {
  const { stdout } = await run(["inspect", "direction"], projectDir);
  const parts: DirectionPart[] = [];
  const orphans: DirectionPart[] = [];
  let acceptance = { status: "unknown", blocking: 0, total: 0 };
  let section = "";
  let inOrphans = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("Orphans")) {
      inOrphans = true;
      continue;
    }
    if (line.startsWith("Acceptance: ")) {
      const body = line.slice("Acceptance: ".length);
      const settled = body.match(/^(accepted|unaccepted) \((\d+) parts\)$/);
      const needsReview = body.match(/^partial — \d+ of (\d+) parts need review \((\d+) /);
      const changed = body.match(/^accepted — (\d+) of (\d+) parts changed since/);
      if (settled) {
        acceptance = { status: settled[1]!, blocking: 0, total: Number(settled[2]) };
      } else if (needsReview) {
        acceptance = {
          status: "partial",
          blocking: Number(needsReview[2]),
          total: Number(needsReview[1]),
        };
      } else if (changed) {
        acceptance = {
          status: "partial",
          blocking: Number(changed[1]),
          total: Number(changed[2]),
        };
      }
      continue;
    }
    if (line.startsWith("  direction:")) {
      const [address, status] = line.trim().split(/\s+/);
      (inOrphans ? orphans : parts).push({ address: address!, section, status: status! });
      continue;
    }
    const heading = line.match(/^([a-z]+): /);
    if (heading) section = heading[1]!;
  }
  return { acceptance, parts, orphans };
}

describe("accept command", () => {
  let projectDir: string;
  let variantId: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();

    const sm = await StateManager.load(projectDir);
    variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/motion.mp4";
    await sm.save();
  });

  it("accepts a variant", async () => {
    const { stdout } = await run(["accept", variantId], projectDir);
    expect(stdout).toContain("Accepted");
    expect(stdout).toContain(address);
    expect(stdout).toContain(variantId);
  });

  // The review surfaces fall back to a stale take, so an accept made by address lands on that one.
  it("accepts by address when every take at it is stale", async () => {
    const sm = await StateManager.load(projectDir);
    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);
    sm.getAssetState(address).variants![variantId]!.inputFingerprints = { [upstream]: "up-old" };
    // Two of them, so the pick is the fallback's newest-first order, not "the only candidate".
    const newer = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![newer]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(address).variants![newer]!.inputFingerprints = { [upstream]: "up-old" };
    await sm.save();

    const { stdout } = await run(["accept", address], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${newer}`);
  });

  it("keeps an input-stale take against the upstream it resolves to now", async () => {
    const sm = await StateManager.load(projectDir);
    const upstream = "video:shot.01.first";
    const up = sm.reserveVariantId(upstream);
    sm.getAssetState(upstream).variants![up]!.file = "/tmp/first.png";
    sm.getAssetState(upstream).variants![up]!.outputHash = "up-current";
    sm.setAccepted(upstream, up);
    sm.getAssetState(address).variants![variantId]!.inputFingerprints = { [upstream]: "up-old" };
    sm.setAccepted(address, variantId);
    await sm.save();

    const { stdout } = await run(["accept", variantId], projectDir);
    expect(stdout).toContain(`kept against newer: ${upstream}`);

    const after = await StateManager.load(projectDir);
    const kept = after.getAssetState(address).variants![variantId]!;
    expect(kept.keptInputs).toEqual({ [upstream]: "up-current" });
    expect(kept.inputFingerprints).toEqual({ [upstream]: "up-old" });
    expect(after.variantStaleness(address, variantId)?.inputStale).toBe(false);

    const { stdout: text } = await run(["accept", variantId], projectDir);
    expect(text).not.toContain("kept against newer");
  });

  it("marks dependents as stale when changing accepted variant", async () => {
    const sm = await StateManager.load(projectDir);
    sm.ensureAssetState("video:shot.01.other");
    sm.setAccepted(address, variantId);

    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", v2], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${v2}`);
    expect((await StateManager.load(projectDir)).getAcceptedVariant(address)).toBe(v2);
  });

  it("dismisses the other takes awaiting a verdict, and says how many", async () => {
    const sm = await StateManager.load(projectDir);
    const rival = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![rival]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(stdout).toContain("1 take(s) dismissed");
    expect(stdout).toMatch(new RegExp(`^Dismissed takes: 1\\n {2}${rival}$`, "m"));

    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(address).variants![rival]!.status).toBe("dismissed");
  });

  // Naming another take IS the decision against the one standing accepted.
  it("dismisses the take it moves the accept off", async () => {
    const sm = await StateManager.load(projectDir);
    const other = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![other]!.file = "/tmp/motion2.mp4";
    sm.setAccepted(address, variantId);
    await sm.save();

    await run(["accept", other, "--yes"], projectDir);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(address)).toBe(other);
    expect(after.getAssetState(address).variants![variantId]!.status).toBe("dismissed");
  });

  // A take the next `generate` replaces was never a candidate, so the accept must not decide it.
  it("leaves a definition-stale sibling alone", async () => {
    const sm = await StateManager.load(projectDir);
    const stale = sm.reserveVariantId(address);
    const staleVariant = sm.getAssetState(address).variants![stale]!;
    staleVariant.file = "/tmp/motion2.mp4";
    staleVariant.definitionHash = "an-older-definition";
    await sm.save();

    const { stdout } = await run(["accept", variantId], projectDir);
    expect(stdout).not.toContain("dismissed");

    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(address).variants![stale]!.status).toBe("none");
  });

  it("fails for non-existent variant", async () => {
    await expect(run(["accept", "v999"], projectDir)).rejects.toThrow();
  });

  it("accepts an address with a single variant", async () => {
    const { stdout } = await run(["accept", address], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${variantId}`);
  });

  // An address means the take on screen, the same one `konte ref` prints — so with several to
  // choose from it signs off the newest ready one, not a question. Signing off an older take is
  // what naming its id is for.
  it("accepts the take an address resolves to when it holds several", async () => {
    const sm = await StateManager.load(projectDir);
    const v2 = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![v2]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", address], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${v2}`);
  });

  // Nothing resolves — every take stale or fileless — so there is no take on screen to mean and
  // the candidate list is the only useful answer.
  it("still reports ambiguity when none of an address's takes resolve", async () => {
    await StateManager.withLock(projectDir, async (m) => {
      const v2 = m.reserveVariantId(address);
      m.getAssetState(address).variants![v2]!.file = null;
      m.getAssetState(address).variants![variantId]!.file = null;
    });

    await expect(run(["accept", address], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_AMBIGUOUS"),
    });
  });

  it("fails for an address with no variants", async () => {
    await expect(run(["accept", "video:shot.01.other"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });
  });

  it("reports a malformed address as INVALID_ADDRESS, not a variant id", async () => {
    await expect(run(["accept", "vide:shot.01.motion"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });

  it("accepts a composition by address, materializing it on demand", async () => {
    // A composition renders its <Audio> too, so every ref must be ready — voice as well as motion.
    const sm = await StateManager.load(projectDir);
    const voiceAddr = "video:shot.01.voice";
    const vv = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![vv]!.file = "/tmp/voice.wav";
    await sm.save();

    // A composition is not pre-materialized: accepting the address renders and accepts a fresh
    // variant in one step.
    const compAddr = "video:shot.01#composition";
    const { stdout } = await run(["accept", compAddr], projectDir);
    const accepted = stdout.match(new RegExp(`^Accepted: ${compAddr} → (v-\\S+)`, "m"))![1]!;
    const reloaded = await StateManager.load(projectDir);
    expect(reloaded.getAcceptedVariant(compAddr)).toBe(accepted);
  });

  it("refuses a composition named by its variant id beside another target", async () => {
    const compAddr = "video:shot.01#composition";
    const sm = await StateManager.load(projectDir);
    const compVid = sm.reserveVariantId(compAddr);
    sm.getAssetState(compAddr).variants![compVid]!.file = "/tmp/composition.mp4";
    await sm.save();

    await expect(run(["accept", compVid, variantId, "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("TARGETS_CONFLICT"),
    });
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).toBeNull();
    expect(after.getAcceptedVariant(address)).toBeNull();
  });

  it("fails to accept a composition whose refs are not ready", async () => {
    // voice (the <Audio> source) has no ready variant, so the composition cannot be rendered.
    await expect(run(["accept", "video:shot.01#composition"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });
  });

  it("fails to accept a stem whose audio source is not ready", async () => {
    // voice (the <Audio> source) has no ready variant, so the stem cannot materialize.
    await expect(run(["accept", "video:shot.01#stem"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });
  });

  it("accepts a stem by address once its audio source is ready", async () => {
    const voiceAddr = "video:shot.01.voice";
    const sm = await StateManager.load(projectDir);
    const vv = sm.reserveVariantId(voiceAddr);
    sm.getAssetState(voiceAddr).variants![vv]!.file = "/tmp/voice.wav";
    await sm.save();

    const stemAddr = "video:shot.01#stem";
    const { stdout } = await run(["accept", stemAddr], projectDir);
    const accepted = stdout.match(new RegExp(`^Accepted: ${stemAddr} → (v-\\S+)`, "m"))![1]!;
    const reloaded = await StateManager.load(projectDir);
    expect(reloaded.getAcceptedVariant(stemAddr)).toBe(accepted);
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

  it("refuses a composition beside another target", async () => {
    await expect(
      run(["accept", "video:shot.01#composition", m2, "--yes"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("TARGETS_CONFLICT") });
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

export default defineReference(direction, () => {
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
});
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

  it("refuses to dismiss one — there is no other take to decide for", async () => {
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

describe("accept command (stale warning)", () => {
  let projectDir: string;
  const motionAddr = "video:shot.01.motion";
  const finalAddr = "video:shot.01.final";

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
  });

  // Sets up an accepted upstream `motion` and a downstream `final` that recorded
  // motion's output. Returns a fresh, unaccepted `motion` variant whose output
  // differs — accepting it makes `final` input-stale.
  async function setupStaleScenario(): Promise<string> {
    const sm = await StateManager.load(projectDir);

    const m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "/tmp/motion1.mp4";
    sm.getAssetState(motionAddr).variants![m1]!.outputHash = "motion-old";
    sm.setAccepted(motionAddr, m1);

    const fin = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![fin]!.file = "/tmp/final.mp4";
    sm.getAssetState(finalAddr).variants![fin]!.inputFingerprints = {
      "video:shot.01.motion": "motion-old",
    };
    sm.setAccepted(finalAddr, fin);

    const m2 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m2]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![m2]!.outputHash = "motion-new";
    await sm.save();

    return m2;
  }

  it("names the accepted takes left on the older upstream", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["accept", m2, "--yes", "--verbose"], projectDir);
    expect(stdout).toMatch(
      new RegExp(`^Still accepted on the older upstream: 1\\n {2}${finalAddr}$`, "m"),
    );

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(finalAddr)).not.toBeNull();
  });

  it("skips prompt with --yes when dependents would become stale", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["accept", m2, "--yes", "--verbose"], projectDir);
    expect(stdout).toContain("Accepted");
    expect(stdout).toContain("Stale assets");
    expect(stdout).toContain("video:shot.01.final");
  });

  it("reports a stale count without listing addresses by default", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["accept", m2, "--yes"], projectDir);
    expect(stdout).toContain("Accepted");
    expect(stdout).toContain("1 asset(s) now stale");
    expect(stdout).not.toContain("video:shot.01.final");
  });

  it("requires confirmation when dependents would become stale", async () => {
    const m2 = await setupStaleScenario();
    const previousAccepted = (await StateManager.load(projectDir)).getAcceptedVariant(motionAddr);

    await expect(run(["accept", m2], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.getAcceptedVariant(motionAddr)).toBe(previousAccepted);
  });

  it("aborts with --no when dependents would become stale", async () => {
    const m2 = await setupStaleScenario();
    const previousAccepted = (await StateManager.load(projectDir)).getAcceptedVariant(motionAddr);

    const { stdout } = await run(["accept", m2, "--no"], projectDir);
    expect(stdout).toContain("stale");
    expect(stdout).toContain("Aborted");

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.getAcceptedVariant(motionAddr)).toBe(previousAccepted);
  });

  it("errors instead of hanging when confirmation is needed non-interactively", async () => {
    const m2 = await setupStaleScenario();
    const previousAccepted = (await StateManager.load(projectDir)).getAcceptedVariant(motionAddr);

    await expect(run(["accept", m2], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const sm2 = await StateManager.load(projectDir);
    expect(sm2.getAcceptedVariant(motionAddr)).toBe(previousAccepted);
  });

  it("aborts inside the lock when a concurrent accept grew the stale set past what was shown", async () => {
    // Consent covers the set the prompt showed (here: just `final`), not a count. A concurrent
    // accept landing between the preview and the lock drags a second consumer into the stale set —
    // one the user never saw — so the commit must abort rather than restale it unasked.
    const secondConsumer = "video:shot.01.final2";
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_WITH_DEPS_TSX.replace(
        'asset("final", enhanceComfy, { source: motion });',
        'asset("final", enhanceComfy, { source: motion });\n      asset("final2", enhanceComfy, { source: motion });',
      ),
    );
    const m2 = await setupStaleScenario();

    // Answer the prompt with "y": the only route to per-set (not blanket `--yes`) consent.
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const fakeStdin = Object.assign(new PassThrough(), { isTTY: true });
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    fakeStdin.write("y\n");

    const realWithLock = StateManager.withLock.bind(StateManager);
    const spy = vi
      .spyOn(StateManager, "withLock")
      .mockImplementation(async <T>(root: string, fn: (m: StateManager) => Promise<T>) => {
        // Intercept only the commit lock; the injected write and the real commit both run
        // through the unmocked implementation.
        spy.mockRestore();
        await realWithLock(root, async (m) => {
          const v = m.reserveVariantId(secondConsumer);
          m.getAssetState(secondConsumer).variants![v]!.file = "/tmp/final2.mp4";
          m.getAssetState(secondConsumer).variants![v]!.inputFingerprints = {
            "video:shot.01.motion": "motion-old",
          };
          m.setAccepted(secondConsumer, v);
        });
        return realWithLock(root, fn);
      });

    try {
      await expect(run(["accept", m2], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
      });
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }

    // Nothing committed: the throw skips save(), so motion still points at the old accept.
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).not.toBe(m2);
  });
});

describe("accept --off", () => {
  let projectDir: string;
  let variantId: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();

    const sm = await StateManager.load(projectDir);
    variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/motion.mp4";
    sm.setAccepted(address, variantId);
    await sm.save();
  });

  it("clears acceptance of a variant", async () => {
    const { stdout } = await run(["accept", variantId, "--off"], projectDir);
    expect(stdout).toContain("Unaccepted");
    expect(stdout).toContain(address);
    expect(stdout).toContain(variantId);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAcceptedVariant(address)).toBeNull();
    expect(sm.getAssetState(address).variants![variantId]!.status).toBe("none");
  });

  // Clearing by address wants the accepted take, and that is what the address resolves to — a
  // second take beside it is not an ambiguity here, since only one of them is accepted at all.
  it("clears by address even when the address holds several takes", async () => {
    await StateManager.withLock(projectDir, async (m) => {
      const v2 = m.reserveVariantId(address);
      m.getAssetState(address).variants![v2]!.file = "/tmp/motion2.mp4";
    });

    const { stdout } = await run(["accept", address, "--off"], projectDir);
    expect(stdout).toContain(`Unaccepted: ${address} → ${variantId}`);
  });

  it("fails for a variant that is not accepted", async () => {
    const sm = await StateManager.load(projectDir);
    const other = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![other]!.file = "/tmp/other.mp4";
    await sm.save();

    await expect(run(["accept", other, "--off"], projectDir)).rejects.toThrow();
  });

  it("dismisses the other takes awaiting a verdict, and says how many", async () => {
    const sm = await StateManager.load(projectDir);
    const rival = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![rival]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(stdout).toContain("1 take(s) dismissed");
    expect(stdout).toMatch(new RegExp(`^Dismissed takes: 1\\n {2}${rival}$`, "m"));

    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(address).variants![rival]!.status).toBe("dismissed");
  });

  // Naming another take IS the decision against the one standing accepted.
  it("dismisses the take it moves the accept off", async () => {
    const sm = await StateManager.load(projectDir);
    const other = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![other]!.file = "/tmp/motion2.mp4";
    sm.setAccepted(address, variantId);
    await sm.save();

    await run(["accept", other, "--yes"], projectDir);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(address)).toBe(other);
    expect(after.getAssetState(address).variants![variantId]!.status).toBe("dismissed");
  });

  // A take the next `generate` replaces was never a candidate, so the accept must not decide it.
  it("leaves a definition-stale sibling alone", async () => {
    const sm = await StateManager.load(projectDir);
    const stale = sm.reserveVariantId(address);
    const staleVariant = sm.getAssetState(address).variants![stale]!;
    staleVariant.file = "/tmp/motion2.mp4";
    staleVariant.definitionHash = "an-older-definition";
    await sm.save();

    const { stdout } = await run(["accept", variantId], projectDir);
    expect(stdout).not.toContain("dismissed");

    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(address).variants![stale]!.status).toBe("none");
  });

  it("fails for non-existent variant", async () => {
    await expect(run(["accept", "v999", "--off"], projectDir)).rejects.toThrow();
  });

  it("gives a leaf-specific message when clearing a composition with nothing accepted", async () => {
    const leaf = "video:shot.01#composition";
    await expect(run(["accept", leaf, "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("has no accepted composition/stem to clear"),
    });
  });
});

describe("accept --off (stale warning)", () => {
  let projectDir: string;
  const motionAddr = "video:shot.01.motion";
  const finalAddr = "video:shot.01.final";

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
  });

  // An accepted `motion` with a newer undecided take beside it, and a `final` built on the accepted
  // output. Clearing the accept hands resolution to the newer take, which is not what `final`
  // recorded — so `final` goes input-stale. Returns the accepted take to clear.
  async function setupStaleScenario(): Promise<string> {
    const sm = await StateManager.load(projectDir);

    const m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "/tmp/motion1.mp4";
    sm.getAssetState(motionAddr).variants![m1]!.outputHash = "motion-old";
    sm.setAccepted(motionAddr, m1);

    const m2 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m2]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![m2]!.outputHash = "motion-new";

    const fin = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![fin]!.file = "/tmp/final.mp4";
    sm.getAssetState(finalAddr).variants![fin]!.inputFingerprints = { [motionAddr]: "motion-old" };
    sm.setAccepted(finalAddr, fin);

    await sm.save();
    return m1;
  }

  it("requires confirmation before propagating stale", async () => {
    const m1 = await setupStaleScenario();

    await expect(run(["accept", m1, "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBe(m1);
  });

  it("reports the committed stale set with --yes", async () => {
    const m1 = await setupStaleScenario();

    const { stdout } = await run(["accept", m1, "--off", "--yes", "--verbose"], projectDir);
    expect(stdout).toContain(finalAddr);
  });

  it("aborts inside the lock when a concurrent write grew the stale set past what was shown", async () => {
    // Consent covers the set the prompt showed (here: just `final`), not a count. A second consumer
    // gaining a take between the preview and the lock is one the user never saw go stale, so the
    // commit must abort rather than restale it unasked.
    const secondConsumer = "video:shot.01.final2";
    await fs.writeFile(
      path.join(projectDir, "video.tsx"),
      TEST_VIDEO_WITH_DEPS_TSX.replace(
        'asset("final", enhanceComfy, { source: motion });',
        'asset("final", enhanceComfy, { source: motion });\n      asset("final2", enhanceComfy, { source: motion });',
      ),
    );
    const m1 = await setupStaleScenario();

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const fakeStdin = Object.assign(new PassThrough(), { isTTY: true });
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    fakeStdin.write("y\n");

    const realWithLock = StateManager.withLock.bind(StateManager);
    const spy = vi
      .spyOn(StateManager, "withLock")
      .mockImplementation(async <T>(root: string, fn: (m: StateManager) => Promise<T>) => {
        spy.mockRestore();
        await realWithLock(root, async (m) => {
          const v = m.reserveVariantId(secondConsumer);
          m.getAssetState(secondConsumer).variants![v]!.file = "/tmp/final2.mp4";
          m.getAssetState(secondConsumer).variants![v]!.inputFingerprints = {
            [motionAddr]: "motion-old",
          };
          m.setAccepted(secondConsumer, v);
        });
        return realWithLock(root, fn);
      });

    try {
      await expect(run(["accept", m1, "--off"], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("State changed since preview"),
      });
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }

    // Nothing committed: the throw skips save(), so the accept still stands.
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(motionAddr)).toBe(m1);
  });
});

// The retune loop the direction cascade exists for: a shot edited while reviewing the media, signed
// off by accepting the take that plays it. The edit is staged on the ACCEPTANCE RECORD rather than
// on direction.ts — `run` is in-process and the loader caches by path, so a file rewritten after the
// first load is invisible here; a part whose stored hash no longer matches the live direction is the
// same state an edit produces, and it is the state the cascade keys off.
describe("accept command (direction cascade)", () => {
  let projectDir: string;
  let variantId: string;
  const address = "video:shot.01.motion";
  const shotPart = "direction:sequence.shots.01";
  const arcPart = "direction:sequence";

  // The blank template ships an empty `shots: []`, so the cascade needs a direction with a shot in
  // it to have anything to carry an accept back to.
  const DIRECTION_SOURCE = `import { defineDirection } from "konte";

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
      { id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] },
    ],
    waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  },
});
`;

  const statePath = () => path.join(projectDir, "konte.state.json");

  async function editAcceptance(
    mutate: (parts: Record<string, { partHash: string; acceptedAt: string }>) => void,
    opts?: { neverAcceptedWhole?: boolean },
  ): Promise<void> {
    const state = JSON.parse(await fs.readFile(statePath(), "utf-8"));
    mutate(state.directionAcceptance.parts);
    // The short-circuit is only ever stamped while the record covers the live set; leaving the old
    // one standing would answer the gate before the per-part walk runs. Dropping `whole` outright is
    // the state before the piece was ever signed off end to end, where R1 still holds.
    state.directionAcceptance.whole = opts?.neverAcceptedWhole
      ? null
      : { ...state.directionAcceptance.whole, hash: null };
    await fs.writeFile(statePath(), JSON.stringify(state, null, 2));
  }

  const directionStatus = async () => (await inspectDirection(projectDir)).acceptance;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), DIRECTION_SOURCE, "utf-8");
    // The fixture board walks the fixture direction this test replaces; swap in one that carries
    // its own.
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_EMPTY_ANIMATIC_TSX, "utf-8");
    await acceptDirection(projectDir);

    const sm = await StateManager.load(projectDir);
    variantId = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![variantId]!.file = "/tmp/motion.mp4";
    await sm.save();
  });

  it("re-accepts the shot and its arc, re-opening the spend gate", async () => {
    // The shot and the root arc whose shape reads its duration — what retuning a shot ages out.
    await editAcceptance((parts) => {
      parts[shotPart]!.partHash = "stale00000000";
      parts[arcPart]!.partHash = "stale11111111";
    });
    expect(await directionStatus()).toMatchObject({ status: "partial", blocking: 2 });

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(directionPartsAccepted(stdout).sort()).toEqual([arcPart, shotPart]);

    expect(await directionStatus()).toMatchObject({ status: "accepted", blocking: 0 });
  });

  // Once the piece has been signed off whole, the take IS the reading — a shot written mid-production
  // is settled by accepting the shot that plays it, which is what carries a finished piece to "every
  // part accepted".
  it("signs off a shot never read, once the whole was accepted", async () => {
    await editAcceptance((parts) => {
      delete parts[shotPart];
    });

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(directionPartsAccepted(stdout)).toContain(shotPart);
    expect(await directionStatus()).toMatchObject({ status: "accepted" });
  });

  // R1, before that point: nothing downstream has been reviewed yet, so a first read is the human's
  // alone and no accept can stand in for it.
  it("leaves a shot never signed off blocking before the whole was accepted", async () => {
    await editAcceptance(
      (parts) => {
        delete parts[shotPart];
      },
      { neverAcceptedWhole: true },
    );

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(directionPartsAccepted(stdout)).not.toContain(shotPart);
    expect(await directionStatus()).toMatchObject({ status: "partial" });
  });

  // The piece-wide agreements are not a shot's to settle.
  it("leaves a stale brief field to the direction review", async () => {
    await editAcceptance((parts) => {
      parts[shotPart]!.partHash = "stale00000000";
      parts["direction:brief.logline"]!.partHash = "stale22222222";
    });

    const { stdout } = await run(["accept", variantId, "--verbose"], projectDir);
    expect(directionPartsAccepted(stdout)).toEqual([shotPart]);
    expect(await directionStatus()).toMatchObject({ status: "partial", blocking: 1 });
  });
});

// `konte accept direction[:<part>]` — the review page's verdict, recorded from the CLI. The fixture
// direction ships two waivers, so it also exercises the one section this path never signs off.
describe("accept direction", () => {
  let projectDir: string;

  const inspect = () => inspectDirection(projectDir);

  const statusOf = async (address: string): Promise<string | undefined> =>
    (await inspect()).parts.find((p) => p.address === address)?.status;

  // An accepted part that no longer exists. Written straight into state rather than by editing
  // direction.ts, so the orphan is the only thing that changes about the direction.
  async function seedOrphan(address: string): Promise<void> {
    const statePath = path.join(projectDir, "konte.state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf-8"));
    state.directionAcceptance.parts[address] = {
      partHash: "orphan000000",
      acceptedAt: new Date().toISOString(),
    };
    state.directionAcceptance.whole = null;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("signs off every part but the waivers", async () => {
    const { stdout } = await run(["accept", "direction", "--verbose"], projectDir);
    const held = addressesUnder(stdout, "Held waiver parts");

    expect(held.length).toBeGreaterThan(0);
    expect(addressesUnder(stdout, "Accepted parts").filter((p) => p.includes(".waivers."))).toEqual(
      [],
    );
    // The held waivers are exactly what is left blocking — nothing else was skipped along the way.
    const after = await inspect();
    expect(after.parts.filter((p) => p.status !== "accepted").map((p) => p.address)).toEqual(held);
    expect(after.acceptance.status).toBe("partial");
  });

  it("refuses to sign off a waiver", async () => {
    const waiver = (await inspect()).parts.find((p) => p.section === "waivers")!.address;
    await expect(run(["accept", waiver], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_ADDRESS"),
    });
  });

  it("signs off one part", async () => {
    const { stdout } = await run(["accept", "direction:brief.logline", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Accepted parts")).toEqual(["direction:brief.logline"]);
    expect(await statusOf("direction:brief.logline")).toBe("accepted");
    expect(await statusOf("direction:brief.tone")).toBe("unaccepted");
  });

  it("rejects a part the direction does not have", async () => {
    await expect(run(["accept", "direction:props.nothing"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("ADDRESS_NOT_FOUND"),
    });
  });

  it("clears one part's sign-off", async () => {
    await run(["accept", "direction"], projectDir);
    const { stdout } = await run(
      ["accept", "direction:brief.tone", "--off", "--verbose"],
      projectDir,
    );
    expect(addressesUnder(stdout, "Cleared parts")).toEqual(["direction:brief.tone"]);
    expect(await statusOf("direction:brief.tone")).toBe("unaccepted");
  });

  it("refuses to clear a part carrying no sign-off", async () => {
    await expect(
      run(["accept", "direction:brief.tone", "--off"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("DIRECTION_PART_NOT_ACCEPTED") });
  });

  it("needs consent to clear the whole direction", async () => {
    await run(["accept", "direction"], projectDir);
    await expect(run(["accept", "direction", "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const { stdout } = await run(["accept", "direction", "--off", "-y"], projectDir);
    expect(stdout).toMatch(/^Acceptance: \d+ of \d+ part\(s\) need review$/m);
    expect((await inspect()).acceptance.status).toBe("unaccepted");
  });

  it("drops the sign-off of a part since deleted", async () => {
    await run(["accept", "direction"], projectDir);
    await seedOrphan("direction:props.gone");

    const { stdout } = await run(["accept", "direction", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Cleared parts")).toEqual(["direction:props.gone"]);
    expect((await inspect()).orphans).toEqual([]);
  });

  it("sweeps a deleted waiver's sign-off without holding it for review", async () => {
    await run(["accept", "direction"], projectDir);
    await seedOrphan("direction:sequence.waivers.gone");
    expect((await inspect()).orphans).toEqual([]);

    const { stdout } = await run(["accept", "direction", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Held waiver parts")).not.toContain(
      "direction:sequence.waivers.gone",
    );
    expect((await inspect()).orphans).toEqual([]);
  });
});

// Both composition stages have leaves. Resolved against the video definition a board address finds
// no such shot — the accept wrote to `video:shot.01#composition` or failed outright.
describe("accept command (animatic leaves)", () => {
  it("materializes and accepts an animatic composition by its address", async () => {
    const projectDir = await initWithCrossStageVideo();
    await acceptDirection(projectDir);

    const keyframe = "animatic:shot.01.keyframe";
    const sm = await StateManager.load(projectDir);
    const kfId = sm.reserveVariantId(keyframe);
    sm.getAssetState(keyframe).variants![kfId]!.file = "assets/kf.png";
    sm.setAccepted(keyframe, kfId);
    await sm.save();

    const comp = "animatic:shot.01#composition";
    await run(["accept", comp, "--yes"], projectDir);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(comp)).not.toBeNull();
    expect(after.tryGetAssetState("video:shot.01#composition")).toBeUndefined();
  });
});
