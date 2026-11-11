import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleGetFullComposition, handleGetReelState } from "../reel-review.js";
import { buildAssetStatus } from "../../../../core/status-report.js";
import { getStage } from "../../../../core/address.js";
import {
  consumedBoardStems,
  planSupersededStemRemakes,
  remakeSettledLeaves,
} from "../../../../core/board-leaves.js";
import { buildDependencyGraph } from "../../../../core/graph.js";
import { stageReviewDecidableAddresses } from "../../../../core/shot-accept-targets.js";
import { StateManager } from "../../../../core/state/index.js";
import { directionAcceptanceView } from "../../../../core/direction-acceptance.js";
import { run, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";
import {
  DIRECTION_TS,
  VIDEO_TSX,
  TRIMMED_VIDEO_TSX,
  STEM_PLAYED_VIDEO_TSX,
  THUMBNAIL_VIDEO_TSX,
  generateAll,
  seed,
  settle,
  acceptAll,
  submitDecision,
  settledShotIds,
  reelPage,
  outstanding,
  project,
  waiveAfterWhole,
} from "./review-closure-harness.js";

vi.setConfig({ testTimeout: 60000 });

useTempWorkspace();

describe("video review closure", () => {
  it("settles, and a review over a settled piece changes nothing", async () => {
    const videoRoot = await project();

    // Two laps: the board's accept materializes the mix the motion consumes, so the build is
    // generated and reviewed on the lap after.
    expect(await settle(videoRoot)).toBe(2);

    // A verdict that has to be given twice is one that did not land.
    await acceptAll(videoRoot);
    const after = await outstanding(videoRoot);
    expect(after.needsReview).toEqual([]);
    expect(after.problems).toEqual([]);
  });

  // A release gives back exactly what the same toggle signed off, on the stage it was made on: the
  // board's accept covers its mix, and rejecting the finished motion says nothing about the audio
  // that drove it.
  it("gives back exactly what its own stage's accept signed off", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).not.toBeNull();

    // The video's release leaves the board alone.
    await submitDecision(videoRoot, "02", "none");
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).not.toBeNull();

    // The board's own release takes its mix with it.
    await submitDecision(videoRoot, "02", "none", undefined, undefined, undefined, "animatic");
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).toBeNull();

    expect(await settle(videoRoot)).toBeLessThanOrEqual(2);
  });

  it("renders the halves the page was told, not the ones it would compute now", async () => {
    const videoRoot = await project();
    await acceptAll(videoRoot, "animatic");
    await generateAll(videoRoot);
    const defs = await loadPreviewDefinitions({ videoRoot, mode: "video-preview" });

    const reel = async (standInShotIds?: string[]): Promise<string> =>
      (
        await handleGetFullComposition(
          defs.video!,
          videoRoot,
          "http://127.0.0.1/assets",
          [],
          defs.animatic,
          standInShotIds,
        )
      ).text();

    // With shot 02's motion gone its build cannot be drawn, so an unpinned reel stands in with the
    // board; a page that was told it saw the delivered picture still gets the delivered picture. The
    // pin replaces the question rather than adding to it.
    const manager = await StateManager.load(videoRoot);
    for (const variantId of Object.keys(
      manager.getAssetState("video:shot.02.motion").variants ?? {},
    )) {
      manager.removeVariant("video:shot.02.motion", variantId);
    }
    await manager.save();
    expect(await reel()).not.toBe(await reel([]));
  });

  // The mix's definition moves under its accept — a retime, a volume change in animatic.tsx — after
  // the video spent on it. Recorded here as the hash an earlier animatic.tsx produced, since this
  // harness cannot re-import an edited stage file. The video develops the shot past the board, so
  // the mix is konte's to re-make on the next spend.
  it("leaves a mix edited after the video spent on it off the board's review", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const manager = await StateManager.load(videoRoot);
    const before = manager.getAcceptedVariant(stem)!;
    manager.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await manager.save();

    expect((await outstanding(videoRoot)).needsReview).not.toContain(stem);
    expect(await settledShotIds(videoRoot, "animatic")).toContain("02");
    expect((await outstanding(videoRoot)).remixes).toEqual([stem]);
  });

  // A retime ages out shot 02's board composition and mix after the video spent on them. The
  // video review's accept re-makes the board's leaves, before any video leaf is built over the mix.
  it.each([
    { through: "the motion it places", videoTsx: VIDEO_TSX },
    { through: "a trim of it", videoTsx: TRIMMED_VIDEO_TSX },
    { through: "the mix it plays", videoTsx: STEM_PLAYED_VIDEO_TSX },
  ])("closes a retime with the video review alone ($through)", async ({ videoTsx }) => {
    const videoRoot = await project("here we go", videoTsx);
    await settle(videoRoot);
    // This harness records no jobs, so no accept cascades into the take a trim was cut from.
    const seeded = await StateManager.load(videoRoot);
    for (const address of ["video:shot.02.raw"]) {
      const variant = seeded.resolveReference(address);
      if (variant && !variant.isAccepted) seeded.setAccepted(address, variant.variantId);
    }
    await seeded.save();
    expect(await outstanding(videoRoot)).toEqual({ needsReview: [], problems: [], remixes: [] });

    const board = ["animatic:shot.02#composition", "animatic:shot.02#stem"];
    const before = board.map((address) => seeded.getAcceptedVariant(address));
    await fs.writeFile(
      path.join(videoRoot, "direction.ts"),
      DIRECTION_TS.replace('join: "continuous", duration: 2', 'join: "continuous", duration: 3'),
    );
    await generateAll(videoRoot);
    expect(await settledShotIds(videoRoot, "animatic")).toContain("02");

    await acceptAll(videoRoot, "video");

    expect(await outstanding(videoRoot)).toEqual({ needsReview: [], problems: [], remixes: [] });
    const after = await StateManager.load(videoRoot);
    for (const [i, address] of board.entries()) {
      expect(after.getAcceptedVariant(address)).not.toBe(before[i]);
    }
  });

  // What `generate` / `reroll` / `patch apply` run before their gate: the mix a spend consumes,
  // re-made once the video has taken it over.
  it("re-mixes a board stem the video has taken over for the next spend", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const manager = await StateManager.load(videoRoot);
    const before = manager.getAcceptedVariant(stem)!;
    manager.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await manager.save();

    const defs = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const remixed = await remakeSettledLeaves({
      videoRoot,
      stage: defs.animatic!,
      counterpart: defs.video!,
      include: "stems",
    });

    expect(remixed).toEqual({ accepted: [{ shotId: "02", address: stem }], failed: [] });
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(stem)).not.toBe(before);
    expect(after.selectVariant(stem, { requireAccepted: true })).not.toBeNull();
  });

  // `reroll` / `patch apply` re-mix only the stems what they redo reaches.
  it("re-mixes only the board stems a targeted spend consumes", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const manager = await StateManager.load(videoRoot);
    const before = manager.getAcceptedVariant(stem)!;
    manager.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await manager.save();

    const defs = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const graph = buildDependencyGraph(defs.video!, defs.animatic!, null);
    expect([...consumedBoardStems(graph, ["video:shot.02.motion"])]).toEqual([stem]);
    expect([...consumedBoardStems(graph, ["video:shot.01.motion"])]).toEqual([]);

    const untouched = await remakeSettledLeaves({
      videoRoot,
      stage: defs.animatic!,
      counterpart: defs.video!,
      addresses: consumedBoardStems(graph, ["video:shot.01.motion"]),
      include: "stems",
    });
    expect(untouched).toEqual({ accepted: [], failed: [] });
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).toBe(before);
  });

  // A plan prices the run: the mix stands re-made in memory, so what consumes it reads as the run
  // will leave it, and nothing is written.
  it("stands a plan's re-mix in memory, aging out what consumes it", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const motion = "video:shot.02.motion";
    const saved = await StateManager.load(videoRoot);
    const before = saved.getAcceptedVariant(stem)!;
    saved.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await saved.save();

    const defs = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const manager = await StateManager.load(videoRoot);
    const planned = planSupersededStemRemakes(manager, defs.animatic!, defs.video!);

    expect(planned).toEqual([{ shotId: "02", address: stem }]);
    expect(manager.selectVariant(stem, { requireAccepted: true })).not.toBeNull();
    const variant = manager.getAcceptedVariant(motion)!;
    expect(manager.variantStaleness(motion, variant)?.inputStale).toBe(true);
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).toBe(before);
  });

  it("names the mix it could not re-make, and why", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const manager = await StateManager.load(videoRoot);
    const before = manager.getAcceptedVariant(stem)!;
    manager.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await manager.save();
    const line = manager.resolveReference("animatic:shot.02.vo")!;
    await fs.writeFile(line.file, "not audio");

    const defs = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const remixed = await remakeSettledLeaves({
      videoRoot,
      stage: defs.animatic!,
      counterpart: defs.video!,
      include: "stems",
    });

    expect(remixed.accepted).toEqual([]);
    expect(remixed.failed).toEqual([
      { shotId: "02", address: stem, reason: expect.stringMatching(/\S/) },
    ]);
    expect((await StateManager.load(videoRoot)).getAcceptedVariant(stem)).toBe(before);
  });

  // A waiver written on a shot after the piece was accepted whole changes no picture, so only the
  // shot's accept can sign it off — the page must offer that accept on a shot already settled.
  it("re-opens a settled shot for a waiver written on it, and its accept signs the waiver off", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);
    await waiveAfterWhole(videoRoot, "02");
    expect(await settledShotIds(videoRoot)).toEqual(["01"]);
    expect((await run(["status"], videoRoot)).stdout).toContain("konte preview video");

    await acceptAll(videoRoot);
    const { direction } = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const after = await StateManager.load(videoRoot);
    expect(directionAcceptanceView(direction!, after.getDirectionAcceptance()).complete).toBe(true);
    expect(await settledShotIds(videoRoot)).toEqual(["01", "02"]);
    expect((await run(["status"], videoRoot)).stdout).not.toMatch(/konte preview (animatic|video)/);
  });

  // A shot drawn from the board alone owns no asset; it is still reviewed on the video stage.
  it("sends a waiver on a shot with no assets of its own to that shot's stage", async () => {
    const videoRoot = await project(
      "here we go",
      VIDEO_TSX.replace(
        `    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "she opens the door" });
      return <Composition><Video src={motion} /></Composition>;
    })`,
        `    shots: shot("01", () => (
      <Composition><Image src={animaticStage.shot("01").image("first")} fill /></Composition>
    ))`,
      ).replace("import { Composition, Video,", "import { Composition, Image, Video,"),
    );
    expect(await settle(videoRoot)).toBe(2);
    await waiveAfterWhole(videoRoot, "01");
    expect(await settledShotIds(videoRoot)).toEqual(["02"]);
    expect((await run(["status"], videoRoot)).stdout).toContain("konte preview video");
  });

  // Materialized once: a second review over unchanged takes reuses the mix rather than minting one.
  it("reuses the mix an unchanged accept already materialized", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);
    const stem = "animatic:shot.02#stem";
    const accepted = (await StateManager.load(videoRoot)).getAcceptedVariant(stem)!;
    await submitDecision(videoRoot, "02", "accepted", undefined, undefined, undefined, "animatic");
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(stem)).toBe(accepted);
    expect(Object.keys(after.getAssetState(stem).variants ?? {})).toEqual([accepted]);
    const file = path.resolve(videoRoot, after.getAssetState(stem).variants![accepted]!.file!);
    expect(file.endsWith("stem.wav")).toBe(true);
    await fs.access(file);
  });

  it("settles after the reviewer accepts an older take from the gallery", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    // A reroll lands beside the accepted take. The reviewer auditions the ORIGINAL and signs THAT
    // off — the path where what the page shows is not what the address resolves to, and where the
    // take they passed over must be settled with the same gesture or it stands as a rival forever.
    const address = "video:shot.01.motion";
    const manager = await StateManager.load(videoRoot);
    const original = manager.getAcceptedVariant(address)!;
    const previous = manager.getAssetState(address).variants![original]!;
    const rerolled = await seed(manager, address, "video");
    const fresh = manager.getAssetState(address).variants![rerolled]!;
    fresh.definitionHash = previous.definitionHash;
    fresh.inputFingerprints = { ...previous.inputFingerprints };
    await manager.save();

    // The page asks again: an undecided take stands beside the accept.
    expect(await settledShotIds(videoRoot)).not.toContain("01");

    await submitDecision(
      videoRoot,
      "01",
      "accepted",
      { [address]: original },
      { [address]: [original, rerolled] },
    );

    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(address)).toBe(original);
    expect(after.getAssetState(address).variants![rerolled]!.status).toBe("dismissed");
    expect((await outstanding(videoRoot)).needsReview).toEqual([]);
    expect(await settledShotIds(videoRoot)).toContain("01");
  });

  it("scopes a shot's verdict addresses to what its own accept lands on", async () => {
    const videoRoot = await project();
    // The board's accept materializes the mix the motion consumes; until then the build has nothing.
    await acceptAll(videoRoot, "animatic");
    await generateAll(videoRoot);
    const defs = await loadPreviewDefinitions({
      videoRoot,
      mode: "video-preview",
    });
    const res = await handleGetReelState(
      {
        videoRoot,
        handoff: null,
        direction: defs.direction,
        animatic: defs.animatic,
        reference: null,
        downstreamVideo: null,
      },
      defs.video!,
      "http://127.0.0.1/assets",
    );
    const page = (await res.json()) as {
      shots: Array<{ shotId: string; showingStandIn?: boolean; verdictAddresses?: string[] }>;
    };
    const shot02 = page.shots.find((s) => s.shotId === "02")!;

    // The board's mix is the animatic review's to settle, so a verdict on this page never lands on
    // it — the page reads these to tell an audition from what stands, and naming it here would let
    // auditioning it read as an unsaved change on a verdict that would not touch it.
    expect(shot02.verdictAddresses).not.toContain("animatic:shot.02#stem");
    expect(shot02.verdictAddresses).toContain("video:shot.02.motion");
  });

  it.each([
    { with: "no thumbnail", videoTsx: VIDEO_TSX },
    { with: "a thumbnail", videoTsx: THUMBNAIL_VIDEO_TSX },
  ])(
    "offers a verdict on every video address status can ask about, with $with",
    async ({ videoTsx }) => {
      const videoRoot = await project(undefined, videoTsx);
      const defs = await loadPreviewDefinitions({
        videoRoot,
        mode: "video-preview",
      });
      const manager = await StateManager.load(videoRoot);
      const { addresses } = await buildAssetStatus({
        videoRoot,
        manager,
        video: defs.video!,
        animatic: defs.animatic!,
        reference: null,
      });

      // I1, stated directly: an address status reports on is one some toggle in `konte preview video`
      // lands a verdict on. A reserved address added without being wired into `shotAcceptTargets`
      // fails here — before it can reach a project and sit under "Needs review" undecidable.
      const decidable = stageReviewDecidableAddresses(manager, defs.video!);
      const video = addresses.filter((a) => getStage(a) === "video");
      expect(video.length).toBeGreaterThan(0);
      expect(video.filter((a) => !decidable.has(a))).toEqual([]);
    },
  );

  it("settles again after the animatic's line is re-recorded", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    // `konte reroll animatic:shot.02.vo` — a second take of the line, awaiting a verdict beside the
    // accepted one. Everything downstream of it is already signed off, which is the state both
    // fixed bugs needed: the mix's consumer is accepted, so no cascade reaches a rebuilt mix.
    const manager = await StateManager.load(videoRoot);
    const vo = "animatic:shot.02.vo";
    const accepted = manager.getAcceptedVariant(vo)!;
    const variant = manager.getAssetState(vo).variants![accepted]!;
    const rerolled = await seed(manager, vo, "audio");
    const fresh = manager.getAssetState(vo).variants![rerolled]!;
    fresh.definitionHash = variant.definitionHash;
    fresh.inputFingerprints = { ...variant.inputFingerprints };
    await manager.save();

    expect((await outstanding(videoRoot)).needsReview).toContain(vo);
    expect(await settle(videoRoot)).toBeLessThanOrEqual(3);
    const after = await outstanding(videoRoot);
    expect(after.needsReview).toEqual([]);
  });

  // The shape of a real session: the line is re-recorded and picked in the same review as the shot.
  // Nothing waits on a generate — the accept mixes the stem over the line it just signed off, whether
  // or not the old mix's accept still stands, and the motion built over the old mix is what goes
  // stale.
  it.each([
    { mix: "awaiting its verdict", keepMixAccept: false },
    { mix: "still accepted", keepMixAccept: true },
  ])(
    "re-mixes the stem over a line picked in the same review ($mix)",
    async ({ keepMixAccept }) => {
      const videoRoot = await project();
      expect(await settle(videoRoot)).toBe(2);

      const manager = await StateManager.load(videoRoot);
      const vo = "animatic:shot.02.vo";
      const stem = "animatic:shot.02#stem";
      const accepted = manager.getAcceptedVariant(vo)!;
      const variant = manager.getAssetState(vo).variants![accepted]!;
      const rerolled = await seed(manager, vo, "audio");
      const fresh = manager.getAssetState(vo).variants![rerolled]!;
      fresh.definitionHash = variant.definitionHash;
      fresh.inputFingerprints = { ...variant.inputFingerprints };
      const oldMix = manager.getAcceptedVariant(stem)!;
      if (!keepMixAccept) manager.setUnaccepted(stem, oldMix);
      await manager.save();

      const page = await reelPage(videoRoot, "animatic");
      expect(page.find((s) => s.shotId === "02")?.notReady).toBe(false);

      const skipped = await submitDecision(
        videoRoot,
        "02",
        "accepted",
        { [vo]: rerolled },
        { [vo]: [accepted, rerolled] },
        undefined,
        "animatic",
      );
      expect(skipped).toEqual([]);
      const after = await StateManager.load(videoRoot);
      expect(after.getAcceptedVariant(vo)).toBe(rerolled);
      const mixed = after.getAcceptedVariant(stem)!;
      expect(mixed).not.toBe(oldMix);
      expect(after.getAssetState(stem).variants![mixed]!.inputFingerprints).toEqual({
        [vo]: rerolled,
      });
      // The motion was driven by the old mix, so it is the video lap's to regenerate.
      expect((await outstanding(videoRoot)).needsReview).not.toContain(stem);
      expect(await settle(videoRoot)).toBeLessThanOrEqual(2);
    },
  );
});
