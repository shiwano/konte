import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  useTempWorkspace,
  initWithTestVideo,
  writeSilentWav,
  readFeedback,
  seedFeedback,
  TEST_VIDEO_TSX,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

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

  it("closes a standing comment it signs off over, and names it", async () => {
    await seedFeedback(projectDir, address, {
      id: "fb-question",
      displayedVariants: { [address]: variantId },
      annotation: null,
      text: "Where is this used?",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "local",
    });

    const { stdout } = await run(["accept", variantId], projectDir);
    expect(stdout).toContain(`Closed: ${address} [fb-question] Where is this used?`);
    const [entry] = await readFeedback(projectDir, address);
    expect(entry?.closedAt).toBeDefined();

    const { stdout: list } = await run(["review", "feedback", "list"], projectDir);
    expect(list).not.toContain("fb-question");
  });

  // Accepting another take moves the comment's subject, which answers it already.
  it("leaves a comment on a take it decides against unclosed", async () => {
    await seedFeedback(projectDir, address, {
      id: "fb-old",
      displayedVariants: { [address]: variantId },
      annotation: null,
      text: "Too dark",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "local",
    });
    const sm = await StateManager.load(projectDir);
    const newer = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![newer]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", newer], projectDir);
    expect(stdout).not.toContain("Closed:");
    const [entry] = await readFeedback(projectDir, address);
    expect(entry?.closedAt).toBeUndefined();
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

  it("accepts by address the take drawn beside a definition-stale accept", async () => {
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(address).variants![variantId]!.definitionHash = "an-older-definition";
    sm.setAccepted(address, variantId);
    const rerolled = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![rerolled]!.file = "/tmp/motion2.mp4";
    await sm.save();

    const { stdout } = await run(["accept", address, "--yes"], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${rerolled}`);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(address)).toBe(rerolled);
    expect(after.getAssetState(address).variants![variantId]!.status).toBe("dismissed");
  });

  it("refuses an address whose definition-stale accept has several takes beside it", async () => {
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(address).variants![variantId]!.definitionHash = "an-older-definition";
    sm.setAccepted(address, variantId);
    for (const file of ["/tmp/motion2.mp4", "/tmp/motion3.mp4"]) {
      sm.getAssetState(address).variants![sm.reserveVariantId(address)]!.file = file;
    }
    await sm.save();

    await expect(run(["accept", address, "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_AMBIGUOUS"),
    });
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(address)).toBe(variantId);
  });

  it("re-accepts a definition-stale accept named by its variant id", async () => {
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(address).variants![variantId]!.definitionHash = "an-older-definition";
    sm.setAccepted(address, variantId);
    const rerolled = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![rerolled]!.file = "/tmp/motion2.mp4";
    await sm.save();

    await run(["accept", variantId, "--yes"], projectDir);

    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(address)).toBe(variantId);
    expect(after.getAssetState(address).variants![rerolled]!.status).toBe("dismissed");
  });

  it("fails for non-existent variant", async () => {
    await expect(run(["accept", "v999"], projectDir)).rejects.toThrow();
  });

  it("accepts an address with a single variant", async () => {
    const { stdout } = await run(["accept", address], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${variantId}`);
  });

  // An address means the take on screen, the same one `konte path` prints — so with several to
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

  it("accepts a target named beside a stage with no shot ready", async () => {
    const { stdout } = await run(["accept", "video", variantId, "--yes"], projectDir);
    expect(stdout).toContain(`Accepted: ${address} → ${variantId}`);
    expect(stdout).toContain("Left unaccepted: video:shot.01 — video:shot.01.voice: no take yet");
  });

  it("refuses a stage with no shot ready, naming what each waits on", async () => {
    await expect(run(["accept", "video", "--yes"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /VARIANT_NOT_FOUND.*video:shot\.01 — video:shot\.01\.voice: no take yet/s,
      ),
    });
  });

  describe("a file asset", () => {
    const voice = "video:shot.01.voice";

    beforeEach(async () => {
      await fs.writeFile(
        path.join(projectDir, "video.tsx"),
        TEST_VIDEO_TSX.replace(
          'const voice = asset("voice", ttsComfy, { text: "hello" });',
          'const voice = asset("voice", adapters.audioFile, { path: "assets/files/voice.wav" });',
        ).replace('defineDirection } from "konte"', 'defineDirection, adapters } from "konte"'),
      );
    });

    it("is accepted by address before anything registered it", async () => {
      await fs.mkdir(path.join(projectDir, "assets", "files"), { recursive: true });
      await writeSilentWav(path.join(projectDir, "assets", "files", "voice.wav"));

      const { stdout } = await run(["accept", voice], projectDir);

      const accepted = (await StateManager.load(projectDir)).getAcceptedVariant(voice);
      expect(accepted).not.toBeNull();
      expect(stdout).toContain(`Accepted: ${voice} → ${accepted}`);
    });

    it("names the path its file is missing from", async () => {
      await expect(run(["accept", voice], projectDir)).rejects.toMatchObject({
        stderr: expect.stringMatching(/VARIANT_NOT_FOUND.*assets\/files\/voice\.wav/s),
      });
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

  it("accepts a composition named by its variant id beside another target", async () => {
    const compAddr = "video:shot.01#composition";
    const sm = await StateManager.load(projectDir);
    const compVid = sm.reserveVariantId(compAddr);
    sm.getAssetState(compAddr).variants![compVid]!.file = "/tmp/composition.mp4";
    await sm.save();

    await run(["accept", compVid, variantId, "--yes"], projectDir);
    const after = await StateManager.load(projectDir);
    expect(after.getAcceptedVariant(compAddr)).toBe(compVid);
    expect(after.getAcceptedVariant(address)).toBe(variantId);
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
