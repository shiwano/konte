import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../core/state/manager.js";
import {
  ctx,
  useTempWorkspace,
  acceptDirection,
  initWithTestVideo,
  initWithCrossStageVideo,
  initWithDepsVideo,
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
      const changed = body.match(
        /^accepted — (\d+) of (\d+) parts (?:not accepted|changed since)(?:, (\d+) changed since)?/,
      );
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
          blocking: Number(changed[1]) + Number(changed[3] ?? 0),
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
    let locks = 0;
    const spy = vi
      .spyOn(StateManager, "withLock")
      .mockImplementation(async <T>(root: string, fn: (m: StateManager) => Promise<T>) => {
        // The first lock syncs file assets. Intercept only the commit lock; the injected write and
        // the real commit both run through the unmocked implementation.
        if (++locks === 1) return realWithLock(root, fn);
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
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en" },
  waivers: { "location-unreferenced_studio": "fixture has no reference stage exposing it" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 , lineup: [] },
    ],
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

// `konte accept direction[:<part>]` — the review page's verdict, recorded from the CLI.
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

  it("holds the part a finding to fix sits on, and only that part", async () => {
    const directionPath = path.join(projectDir, "direction.ts");
    const source = await fs.readFile(directionPath, "utf-8");
    await fs.writeFile(
      directionPath,
      source
        .replace(
          "  locations: {",
          '  props: { cup: { name: "the cup", description: "a chipped cup", promptDepiction: "cup" } },\n  locations: {',
        )
        .replace(/lineup: \[[^\]]*\],/g, "$& props: [],"),
    );

    await expect(run(["accept", "direction:props.cup"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringMatching(/REVIEW_HELD[\s\S]*\[unused-prop_cup\]/),
    });
    await run(["accept", "direction:brief"], projectDir);
    expect(await statusOf("direction:brief.logline")).toBe("accepted");
  });

  it("signs off every part, the waivers included", async () => {
    const { stdout } = await run(["accept", "direction", "--verbose"], projectDir);

    expect(
      addressesUnder(stdout, "Accepted parts").filter((p) => p.startsWith("direction:waivers.")),
    ).not.toEqual([]);
    const after = await inspect();
    expect(after.parts.filter((p) => p.status !== "accepted")).toEqual([]);
    expect(after.acceptance.status).toBe("accepted");
  });

  it("signs off a waiver", async () => {
    const waiver = (await inspect()).parts.find((p) => p.section === "waivers")!.address;
    await run(["accept", waiver], projectDir);
    expect(await statusOf(waiver)).toBe("accepted");
  });

  it("signs off one part", async () => {
    const { stdout } = await run(["accept", "direction:brief.logline", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Accepted parts")).toEqual(["direction:brief.logline"]);
    expect(await statusOf("direction:brief.logline")).toBe("accepted");
    expect(await statusOf("direction:brief.tone")).toBe("unaccepted");
  });

  it("signs off every part under a group scope", async () => {
    const brief = (await inspect()).parts
      .filter((p) => p.address.startsWith("direction:brief."))
      .map((p) => p.address);
    const { stdout } = await run(["accept", "direction:brief", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Accepted parts").sort()).toEqual([...brief].sort());
    expect(await statusOf("direction:brief.logline")).toBe("accepted");
    expect(await statusOf("direction:policy.format")).toBe("unaccepted");
  });

  it("signs off several scopes in one run", async () => {
    const { stdout } = await run(
      ["accept", "direction:brief.logline", "direction:brief.tone", "--verbose"],
      projectDir,
    );
    expect(addressesUnder(stdout, "Accepted parts")).toEqual([
      "direction:brief.logline",
      "direction:brief.tone",
    ]);
  });

  it("needs consent to clear several parts", async () => {
    await run(["accept", "direction"], projectDir);
    await expect(run(["accept", "direction:brief", "--off"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });
    await run(["accept", "direction:brief", "--off", "-y"], projectDir);
    expect(await statusOf("direction:brief.logline")).toBe("unaccepted");
  });

  it("rejects a part the direction does not have", async () => {
    const err: { stderr: string } = await run(
      ["accept", "direction:props.nothing"],
      projectDir,
    ).then(
      () => expect.fail("accept should refuse"),
      (e) => e,
    );
    expect(err.stderr).toContain("ADDRESS_NOT_FOUND");
    expect(err.stderr.match(/^Error \[/gm)).toHaveLength(1);
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
    await seedOrphan("direction:waivers.gone");
    expect((await inspect()).orphans).toEqual([]);
  });
});

describe("accept direction (no shots yet)", () => {
  let projectDir: string;

  const SHOTLESS_DIRECTION_SOURCE = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en" },
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
});
`;

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
    await fs.writeFile(path.join(projectDir, "direction.ts"), SHOTLESS_DIRECTION_SOURCE, "utf-8");
    await fs.writeFile(path.join(projectDir, "animatic.tsx"), TEST_EMPTY_ANIMATIC_TSX, "utf-8");
  });

  it("holds the flow back from a whole accept", async () => {
    const { stdout } = await run(["accept", "direction", "--verbose"], projectDir);
    expect(addressesUnder(stdout, "Held flow parts")).toEqual(["direction:sequence"]);
    const after = await inspectDirection(projectDir);
    expect(after.parts.filter((p) => p.status !== "accepted").map((p) => p.address)).toEqual([
      "direction:sequence",
    ]);
  });

  it("refuses to sign off the flow", async () => {
    await expect(run(["accept", "direction:sequence"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("DIRECTION_SHOTS_UNWRITTEN"),
    });
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

describe("accept with whitespace-joined targets", () => {
  it("refuses one argument holding several addresses", async () => {
    await expect(
      run(["accept", "reference:bakerStreet reference:church"], ctx.dir),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/JOINED_ARGUMENTS.*2 whitespace-separated values/),
    });
  });

  it("refuses a variadic option value holding several targets", async () => {
    await expect(
      run(["dismiss", "video", "--except", "v-aaaa v-bbbb"], ctx.dir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("JOINED_ARGUMENTS") });
  });
});
