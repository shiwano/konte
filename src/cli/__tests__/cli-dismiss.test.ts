import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  useTempWorkspace,
  initWithTestVideo,
  initWithDepsVideo,
  TEST_VIDEO_WITH_DEPS_TSX,
  run,
} from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("dismiss command", () => {
  let projectDir: string;
  let older: string;
  let newer: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();

    const sm = await StateManager.load(projectDir);
    older = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![older]!.file = "/tmp/motion1.mp4";
    newer = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![newer]!.file = "/tmp/motion2.mp4";
    await sm.save();
  });

  it("hands the address back to the take before the one dismissed", async () => {
    const { stdout } = await run(["dismiss", newer], projectDir);
    expect(stdout).toContain(`Dismissed: ${address} → ${newer} (now showing ${older})`);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAssetState(address).variants![newer]!.status).toBe("dismissed");
    expect(sm.getAssetState(address).variants![older]!.status).toBe("none");
  });

  it("dismisses the take an address is showing", async () => {
    const { stdout } = await run(["dismiss", address], projectDir);
    expect(stdout).toContain(`Dismissed: ${address} → ${newer}`);
    expect(stdout).toContain(`(now showing ${older})`);
  });

  it("dismisses several takes in one call", async () => {
    const { stdout } = await run(["dismiss", newer, older], projectDir);
    expect(stdout.trim().split("\n")).toEqual([
      `Dismissed: ${address} → ${newer} (nothing resolves now — konte generate rebuilds it)`,
      `Dismissed: ${address} → ${older} (nothing resolves now — konte generate rebuilds it)`,
    ]);
  });

  it("says so when the address is left resolving to nothing", async () => {
    await run(["dismiss", newer], projectDir);
    const { stdout } = await run(["dismiss", older], projectDir);
    expect(stdout).toContain("nothing resolves now");
  });

  it("refuses the accepted take", async () => {
    const sm = await StateManager.load(projectDir);
    sm.setAccepted(address, newer);
    await sm.save();

    await expect(run(["dismiss", newer], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_ACCEPTED"),
    });
  });

  it("lifts a dismissal with --off", async () => {
    await run(["dismiss", newer], projectDir);

    const { stdout } = await run(["dismiss", newer, "--off"], projectDir);
    expect(stdout).toContain(`Undecided: ${address} → ${newer} (now showing ${newer})`);

    const sm = await StateManager.load(projectDir);
    expect(sm.getAssetState(address).variants![newer]!.status).toBe("none");
  });

  it("refuses --off on a take carrying no dismissal", async () => {
    await expect(run(["dismiss", newer, "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_DISMISSED"),
    });
  });

  it("decides nothing when one of several targets is invalid", async () => {
    await expect(run(["dismiss", newer, "v999"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_FOUND"),
    });

    const sm = await StateManager.load(projectDir);
    expect(sm.getAssetState(address).variants![newer]!.status).toBe("none");
  });

  // The definition axis decides what an address resolves to, so it has to be registered before the
  // target is resolved — otherwise "throw out what is showing" lands on the newest take instead.
  it("lands an address target on the take the review surfaces show, not the newest", async () => {
    const sm = await StateManager.load(projectDir);
    sm.getAssetState(address).variants![newer]!.definitionHash = "moved-since";
    await sm.save();

    const { stdout } = await run(["dismiss", address], projectDir);
    expect(stdout).toContain(`Dismissed: ${address} → ${older} (now showing ${newer})`);
  });

  it("refuses a take a patch was made from, and takes its correction instead", async () => {
    const sm = await StateManager.load(projectDir);
    const fix = sm.reserveVariantId(address);
    sm.getAssetState(address).variants![fix]!.file = "/tmp/fix.mp4";
    sm.getAssetState(address).variants![fix]!.derivedFrom = newer;
    await sm.save();

    await expect(run(["dismiss", newer], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_REVIEWABLE"),
    });

    const { stdout } = await run(["dismiss", fix], projectDir);
    expect(stdout).toContain(`Dismissed: ${address} → ${fix}`);
  });

  it("refuses a take whose job has produced nothing", async () => {
    const sm = await StateManager.load(projectDir);
    const running = sm.reserveVariantId(address);
    await sm.save();

    await expect(run(["dismiss", running], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("VARIANT_NOT_REVIEWABLE"),
    });
  });

  it("treats a repeat as no decision at all", async () => {
    await run(["dismiss", newer], projectDir);
    const decidedAt = (await StateManager.load(projectDir)).getAssetState(address).variants![newer]!
      .decidedAt;

    const { stdout } = await run(["dismiss", newer], projectDir);
    expect(stdout).not.toContain("now stale");

    const after = (await StateManager.load(projectDir)).getAssetState(address).variants![newer]!
      .decidedAt;
    expect(after).toBe(decidedAt);
  });
});

describe("dismiss command (stale warning)", () => {
  let projectDir: string;
  const motionAddr = "video:shot.01.motion";
  const finalAddr = "video:shot.01.final";

  beforeEach(async () => {
    projectDir = await initWithDepsVideo();
  });

  // An undecided `motion` pair where the newer take is what resolves, and a downstream `final`
  // built on it. Dismissing the newer take drops `motion` back to the older output, which is not
  // what `final` recorded — so `final` goes input-stale. Returns the take to dismiss.
  async function setupStaleScenario(): Promise<string> {
    const sm = await StateManager.load(projectDir);

    const m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "/tmp/motion1.mp4";
    sm.getAssetState(motionAddr).variants![m1]!.outputHash = "motion-old";

    const m2 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m2]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![m2]!.outputHash = "motion-new";

    const fin = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![fin]!.file = "/tmp/final.mp4";
    sm.getAssetState(finalAddr).variants![fin]!.inputFingerprints = { [motionAddr]: "motion-new" };
    sm.setAccepted(finalAddr, fin);

    await sm.save();
    return m2;
  }

  it("reports what it makes stale with --yes", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["dismiss", m2, "--yes", "--verbose"], projectDir);
    expect(stdout).toContain("Dismissed");
    expect(stdout).toContain("Stale assets");
    expect(stdout).toContain(finalAddr);
  });

  it("counts them without listing by default", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["dismiss", m2, "--yes"], projectDir);
    expect(stdout).toContain("1 asset(s) now stale");
    expect(stdout).not.toContain(finalAddr);
  });

  it("requires confirmation before propagating stale", async () => {
    const m2 = await setupStaleScenario();

    await expect(run(["dismiss", m2], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });

    const sm = await StateManager.load(projectDir);
    expect(sm.getAssetState(motionAddr).variants![m2]!.status).toBe("none");
  });

  it("aborts with --no", async () => {
    const m2 = await setupStaleScenario();

    const { stdout } = await run(["dismiss", m2, "--no"], projectDir);
    expect(stdout).toContain("Aborted");

    const sm = await StateManager.load(projectDir);
    expect(sm.getAssetState(motionAddr).variants![m2]!.status).toBe("none");
  });

  // Lifting a dismissal moves resolution just as making one does.
  it("propagates stale when --off puts a take back in the running", async () => {
    const sm = await StateManager.load(projectDir);

    const m1 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m1]!.file = "/tmp/motion1.mp4";
    sm.getAssetState(motionAddr).variants![m1]!.outputHash = "motion-old";

    const m2 = sm.reserveVariantId(motionAddr);
    sm.getAssetState(motionAddr).variants![m2]!.file = "/tmp/motion2.mp4";
    sm.getAssetState(motionAddr).variants![m2]!.outputHash = "motion-new";
    sm.setDismissed(motionAddr, m2, true);

    const fin = sm.reserveVariantId(finalAddr);
    sm.getAssetState(finalAddr).variants![fin]!.file = "/tmp/final.mp4";
    sm.getAssetState(finalAddr).variants![fin]!.inputFingerprints = { [motionAddr]: "motion-old" };
    sm.setAccepted(finalAddr, fin);
    await sm.save();

    const { stdout } = await run(["dismiss", m2, "--off", "--yes", "--verbose"], projectDir);
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
        spy.mockRestore();
        await realWithLock(root, async (m) => {
          const v = m.reserveVariantId(secondConsumer);
          m.getAssetState(secondConsumer).variants![v]!.file = "/tmp/final2.mp4";
          m.getAssetState(secondConsumer).variants![v]!.inputFingerprints = {
            [motionAddr]: "motion-new",
          };
          m.setAccepted(secondConsumer, v);
        });
        return realWithLock(root, fn);
      });

    try {
      await expect(run(["dismiss", m2], projectDir)).rejects.toMatchObject({
        stderr: expect.stringContaining("State changed since preview"),
      });
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }

    // Nothing committed: the throw skips save(), so the take is still in the running.
    const after = await StateManager.load(projectDir);
    expect(after.getAssetState(motionAddr).variants![m2]!.status).toBe("none");
  });
});
