import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleGetFullComposition, handleGetReelState, handleReelSubmit } from "../reel-review.js";
import { buildAssetStatus, needsReviewItems } from "../../../asset-status.js";
import {
  type DefinitionLike,
  getAssetEntryByAddress,
  getStage,
  listAddresses,
} from "../../../../core/address.js";
import { compositionInputFingerprints } from "../../../../core/composition-resource.js";
import { computeDefinitionHash } from "../../../../core/definition-hash.js";
import { extractRefs } from "../../../../core/graph.js";
import { stageReviewDecidableAddresses } from "../../../../core/shot-accept-targets.js";
import { stableStringify } from "../../../../core/stable-stringify.js";
import type { AssetDefinition } from "../../../../core/types/index.js";
import { reloadVideoDefinition } from "../../../../core/loader.js";
import { StateManager } from "../../../../core/state/index.js";
import {
  ctx,
  initWorkspace,
  useTempWorkspace,
  writeSilentWav,
} from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 60000 });

useTempWorkspace();

/**
 * The closure invariant over ONE fixture: accept everything `konte preview video` offers, generate
 * what that releases, repeat — and `status` must reach a state with nothing under "Needs review"
 * and no shot behind the animatic gate.
 *
 * It is checked on a LATER lap, not the first: every bug of this shape has been invisible on a fresh
 * project. So each case signs the piece off, moves something, and demands another round close it
 * again.
 *
 * Scope: the video review only, and the fixture's own shapes. Generation is faked by writing takes
 * into state, so this proves nothing about `generate` / `reroll` / `patch apply` — their agreement
 * with the gates is their own tests'.
 */

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "she opens the door", setup: "front", duration: 2 },
      { id: "02", role: "beat", action: "she steps through", setup: "front", duration: 2 },
    ],
  },
});
`;

const animaticTsx = (
  line: string,
): string => `import { defineAnimatic, defineFalAsset, asset, Audio, Composition, Panel } from "konte";
import direction from "./direction";

const frame = defineFalAsset({
  endpointId: "test/frame",
  description: "test adapter",
  mediaType: "image",
  inputs: { prompt: { field: "prompt", type: "prompt" } },
});

const tts = defineFalAsset({
  endpointId: "test/tts",
  description: "test adapter",
  mediaType: "audio",
  inputs: { text: { field: "text", type: "string" } },
});

export default defineAnimatic(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => (
      <Composition>
        <Panel src={asset("first", frame, { prompt: "the door" })} blocking="she turns" camera="static" />
      </Composition>
    )).nextShot("02", () => (
      <Composition>
        <Panel src={asset("first", frame, { prompt: "through it" })} blocking="she walks" camera="static" />
        <Audio src={asset("vo", tts, { text: ${JSON.stringify(line)} })} />
      </Composition>
    )),
  }),
});
`;

// Shot 02 is the shape both bugs lived in: the board sounds its line, and the video build feeds
// `animatic.shot("02").stem` to the motion model as an ASSET INPUT — so nothing in the delivered
// composition places that mix. The board's accept materializes it.
const VIDEO_TSX = `import { Composition, Video, defineVideo, defineFalAsset, asset } from "konte";
import direction from "./direction";
import animaticStage from "./animatic";

const animate = defineFalAsset({
  endpointId: "test/animate",
  description: "test adapter",
  mediaType: "video",
  inputs: { prompt: { field: "prompt", type: "prompt" } },
});

const ia2v = defineFalAsset({
  endpointId: "test/ia2v",
  description: "test adapter",
  mediaType: "video",
  inputs: {
    prompt: { field: "prompt", type: "prompt" },
    audio: { field: "audio_url", type: "audio" },
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "she opens the door" });
      return <Composition><Video src={motion} /></Composition>;
    }).nextShot("02", () => {
      const motion = asset("motion", ia2v, {
        prompt: "she steps through",
        audio: animaticStage.shot("02").stem,
      });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

// One asset row of the review page — a per-shot take or an audio-track cue.
interface Row {
  address: string;
  variantId: string | null;
  variants?: Array<{ variantId: string; isNew?: boolean }>;
}

const EXT: Record<string, string> = { image: ".png", video: ".mp4", audio: ".wav" };

/**
 * A miniature `konte generate`: give every out-of-date address a take, recording the same
 * `(definitionHash, inputFingerprints)` pair the real pipeline stamps, so staleness behaves here as
 * it does in a project. Driven off the definition rather than a hand-written list, so an address a
 * future change adds is generated — and therefore reviewed — without this fixture being edited.
 *
 * Board takes land accepted: the animatic has a review of its own, and this file is about the
 * video's. Repeats to a fixed point, the way generate registers a level at a time. Leaves are not
 * generated — the board's stem is materialized by its accept, and until then the motion consuming
 * it has nothing to resolve, exactly as `generate video` would find.
 */
async function generateAll(videoRoot: string): Promise<void> {
  // Always a reload: this stands in for a `generate` run after an edit, and a cached module would
  // generate against the definition the previous lap saw. Busting here leaves every later plain load
  // fresh too, the way the preview watcher's reload does.
  const defs = await loadPreviewDefinitions({
    videoRoot,
    videoPath: path.join(videoRoot, "video.tsx"),
    mode: "video-preview",
    reload: true,
  });
  const manager = await StateManager.load(videoRoot);
  const stages: Array<{ stage: "animatic" | "video"; definition: DefinitionLike | null }> = [
    { stage: "animatic", definition: defs.animatic },
    { stage: "video", definition: defs.video! },
  ];

  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const { stage, definition } of stages) {
      if (!definition) continue;
      for (const address of listAddresses(definition, stage)) {
        const entry = getAssetEntryByAddress(definition, address);
        // Dependency order, the way generate registers a level at a time: seeding an address before
        // its inputs exist would record empty fingerprints and leave a rival take behind, which no
        // real run produces.
        const refs = extractRefs(entry);
        if (refs.some((ref) => !manager.resolveReference(ref))) continue;
        const definitionHash = computeDefinitionHash(entry);
        const inputFingerprints = compositionInputFingerprints(manager, refs);
        const current = Object.values(manager.tryGetAssetState(address)?.variants ?? {}).some(
          (v) =>
            v.definitionHash === definitionHash &&
            stableStringify(v.inputFingerprints ?? {}) === stableStringify(inputFingerprints),
        );
        if (current) continue;
        const variantId = await seed(manager, address, mediaTypeOf(entry));
        const variant = manager.getAssetState(address).variants![variantId]!;
        variant.definitionHash = definitionHash;
        variant.inputFingerprints = inputFingerprints;
        if (stage === "animatic") manager.setAccepted(address, variantId);
        changed = true;
      }
    }
    if (!changed) break;
  }
  await manager.save();
}

// An audio take is a real (silent) file: the board's accept mixes the shot's cues with ffmpeg.
async function seed(manager: StateManager, address: string, mediaType: string): Promise<string> {
  const variantId = manager.reserveVariantId(address);
  const variant = manager.getAssetState(address).variants![variantId]!;
  variant.file = `assets/${variantId}${EXT[mediaType] ?? ".mp4"}`;
  variant.outputHash = variantId;
  if (mediaType === "audio") await writeSilentWav(path.join(manager.videoRoot, variant.file));
  return variantId;
}

function mediaTypeOf(entry: AssetDefinition): string {
  if (entry.kind === "fal" || entry.kind === "local") return entry.mediaType;
  return "video";
}

/**
 * The loop a session actually runs: review everything on offer, generate whatever that released,
 * and go round again. More than one lap is expected — a shot signed off as an animatic releases its
 * build's spend, and the build is reviewed on the lap after — so what is asserted is that the loop
 * REACHES a fixed point, and how many laps it takes.
 *
 * Returns `maxLaps + 1` when it never settles, which is the failure this file exists to catch: work
 * `status` keeps asking for that going round again does not clear.
 */
async function settle(videoRoot: string, maxLaps = 5): Promise<number> {
  for (let lap = 1; lap <= maxLaps; lap++) {
    // A lap is one pass over the whole piece: the board first, then what its accept releases.
    await acceptAll(videoRoot, "animatic");
    await acceptAll(videoRoot, "video");
    await generateAll(videoRoot);
    const left = await outstanding(videoRoot);
    if (left.needsReview.length === 0 && left.problems.length === 0) {
      return lap;
    }
  }
  return maxLaps + 1;
}

async function acceptAll(
  videoRoot: string,
  stage: "animatic" | "video" = "video",
): Promise<Record<string, unknown>> {
  const videoPath = path.join(videoRoot, "video.tsx");
  const defs = await loadPreviewDefinitions({ videoRoot, videoPath, mode: "video-preview" });
  const reel = stage === "animatic" ? defs.animatic! : defs.video!;
  const stateRes = await handleGetReelState(
    videoRoot,
    reel,
    "http://127.0.0.1/assets",
    null,
    defs.direction,
    defs.animatic,
  );
  const page = (await stateRes.json()) as {
    shots: Array<{
      shotId: string;
      pending?: boolean;
      needsVerdict?: boolean;
      showingStandIn?: boolean;
      notReady?: boolean;
      assets?: Row[];
    }>;
    audioAssets?: Row[];
    timelineStem?: unknown;
  };

  const decisions: Record<string, string> = {};
  const displayedVariants: Record<string, string> = {};
  const displayedCandidates: Record<string, string[]> = {};
  // The reviewer takes the newest take an address offers and settles the rest — the gallery as the
  // page rendered it, so an accept decides against what it passed over rather than leaving a rival
  // standing (which would read as "needs review" forever).
  const choose = (row: Row): void => {
    const newest = row.variants?.find((v) => v.isNew)?.variantId ?? row.variantId;
    if (newest) displayedVariants[row.address] = newest;
    if (row.variants?.length) {
      displayedCandidates[row.address] = row.variants.map((v) => v.variantId);
    }
  };
  for (const shot of page.shots) {
    // The page closes the toggle on all three (`shotAcceptable`), so none carries a verdict.
    if (shot.pending || shot.showingStandIn || shot.notReady) continue;
    if (shot.needsVerdict) decisions[shot.shotId] = "accepted";
    for (const row of shot.assets ?? []) choose(row);
  }
  for (const row of page.audioAssets ?? []) choose(row);

  const res = await handleReelSubmit(
    videoRoot,
    async () => (stage === "animatic" ? defs.animatic! : reloadVideoDefinition(videoPath)),
    null,
    defs.direction,
    defs.animatic,
    new Request(`http://127.0.0.1/api/${stage}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisions,
        displayedVariants,
        displayedCandidates,
        // Accept all marks the beds too, when the timeline has any.
        ...(page.timelineStem ? { timelineStemDecision: "accepted" } : {}),
        displayedStandInShotIds: page.shots.filter((s) => s.showingStandIn).map((s) => s.shotId),
      }),
    }),
  );
  expect(res.status).toBe(200);
  const payload = (await res.json()) as {
    skippedDecisions?: Array<{ shotId?: string; address: string; reason: string }>;
  };
  // The real client throws on a 200 carrying these, so a harness that read past them would call a
  // review landed that state does not back — and go round another lap on work no reviewer could
  // have closed.
  expect(payload.skippedDecisions ?? []).toEqual([]);
  return payload as Record<string, unknown>;
}

// One shot's verdict. `displayedVariants` stands in for a gallery pick — the take the reviewer was
// auditioning when they decided, which submit accepts in place of whatever the address resolves to.
async function submitDecision(
  videoRoot: string,
  shotId: string,
  decision: "accepted" | "none",
  displayedVariants?: Record<string, string>,
  displayedCandidates?: Record<string, string[]>,
  // The stand-ins the page was showing. Overridden where a test needs the race the pin exists for: a
  // take landing after the page loaded, which would flip the answer if the submit re-derived it.
  standInShotIds?: string[],
  stage: "animatic" | "video" = "video",
): Promise<Array<{ address: string; reason: string }>> {
  const videoPath = path.join(videoRoot, "video.tsx");
  const defs = await loadPreviewDefinitions({ videoRoot, videoPath, mode: "video-preview" });
  const stateRes = await handleGetReelState(
    videoRoot,
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
    null,
    defs.direction,
    defs.animatic,
  );
  const page = (await stateRes.json()) as {
    shots: Array<{ shotId: string; showingStandIn?: boolean }>;
  };
  const res = await handleReelSubmit(
    videoRoot,
    async () => (stage === "animatic" ? defs.animatic! : reloadVideoDefinition(videoPath)),
    null,
    defs.direction,
    defs.animatic,
    new Request(`http://127.0.0.1/api/${stage}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisions: { [shotId]: decision },
        ...(displayedVariants ? { displayedVariants } : {}),
        ...(displayedCandidates ? { displayedCandidates } : {}),
        displayedStandInShotIds:
          standInShotIds ?? page.shots.filter((s) => s.showingStandIn).map((s) => s.shotId),
      }),
    }),
  );
  expect(res.status).toBe(200);
  const payload = (await res.json()) as {
    skippedDecisions?: Array<{ address: string; reason: string }>;
  };
  return payload.skippedDecisions ?? [];
}

// The shots the page reports as needing nothing — what decides whether its accept toggle starts
// checked, and therefore whether an accept-all touches the shot at all.
async function settledShotIds(
  videoRoot: string,
  stage: "animatic" | "video" = "video",
): Promise<string[]> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    videoPath: path.join(videoRoot, "video.tsx"),
    mode: "video-preview",
  });
  const res = await handleGetReelState(
    videoRoot,
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
    null,
    defs.direction,
    defs.animatic,
  );
  const page = (await res.json()) as {
    shots: Array<{ shotId: string; needsVerdict?: boolean; showingStandIn?: boolean }>;
  };
  // The client's own baseline (`baseShotAccepted`), minus the preview override this harness never
  // sets: a shot reading settled here is one Accept all skips.
  return page.shots.filter((s) => !s.showingStandIn && !s.needsVerdict).map((s) => s.shotId);
}

async function reelPage(
  videoRoot: string,
  stage: "animatic" | "video",
): Promise<Array<{ shotId: string; notReady: boolean; needsVerdict?: boolean }>> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    videoPath: path.join(videoRoot, "video.tsx"),
    mode: "video-preview",
  });
  const res = await handleGetReelState(
    videoRoot,
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
    null,
    defs.direction,
    defs.animatic,
  );
  return ((await res.json()) as { shots: Array<{ shotId: string; notReady: boolean }> }).shots;
}

async function outstanding(
  videoRoot: string,
): Promise<{ needsReview: string[]; problems: string[] }> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    videoPath: path.join(videoRoot, "video.tsx"),
    mode: "video-preview",
  });
  const manager = await StateManager.load(videoRoot);
  const { report } = await buildAssetStatus({
    videoRoot,
    manager,
    video: defs.video!,
    animatic: defs.animatic!,
    reference: null,
  });
  return {
    needsReview: needsReviewItems(report).map((i) => i.address),
    problems: (report.sections.find((s) => s.title === "Problems")?.items ?? []).map(
      (i) => `${i.address} ${i.detail}`,
    ),
  };
}

async function project(animaticLine = "here we go"): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "closure"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), animaticTsx(animaticLine));
  await fs.writeFile(path.join(videoRoot, "video.tsx"), VIDEO_TSX);
  await generateAll(videoRoot);
  return videoRoot;
}

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
    const videoPath = path.join(videoRoot, "video.tsx");
    const defs = await loadPreviewDefinitions({ videoRoot, videoPath, mode: "video-preview" });

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

  // The mix's definition moves under its accept — a retime, a volume change in animatic.tsx — while
  // everything else stays signed off. Recorded here as the hash an earlier animatic.tsx produced,
  // since this harness cannot re-import an edited stage file. No generate is owed: the page mixes
  // the cues live, so the shot re-opens for a verdict, and its accept materializes the new mix. The
  // motion built over the old one is what the lap regenerates.
  it("re-opens the shot when its mix is edited, and the next review closes it", async () => {
    const videoRoot = await project();
    expect(await settle(videoRoot)).toBe(2);

    const stem = "animatic:shot.02#stem";
    const manager = await StateManager.load(videoRoot);
    const before = manager.getAcceptedVariant(stem)!;
    manager.getAssetState(stem).variants![before]!.definitionHash = "an earlier animatic.tsx";
    await manager.save();

    expect((await outstanding(videoRoot)).needsReview).toContain(stem);
    const page = await reelPage(videoRoot, "animatic");
    expect(page.find((s) => s.shotId === "02")?.notReady).toBe(false);
    expect(await settledShotIds(videoRoot, "animatic")).not.toContain("02");
    expect(await settle(videoRoot)).toBeLessThanOrEqual(2);
    expect(await settledShotIds(videoRoot, "animatic")).toContain("02");
    const after = await StateManager.load(videoRoot);
    expect(after.getAcceptedVariant(stem)).not.toBe(before);
    expect(after.getAssetState(stem).variants![before]!.status).toBe("none");
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
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "video-preview",
    });
    const res = await handleGetReelState(
      videoRoot,
      defs.video!,
      "http://127.0.0.1/assets",
      null,
      defs.direction,
      defs.animatic,
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

  it("offers a verdict on every video address status can ask about", async () => {
    const videoRoot = await project();
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
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
  });

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
