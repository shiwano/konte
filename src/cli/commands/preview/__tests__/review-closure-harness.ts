import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect } from "vitest";

import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleGetReelState } from "../reel-review.js";
import { handleReelSubmit } from "../reel-submit.js";
import { buildAssetStatus, needsReviewItems } from "../../../../core/status-report.js";
import { type DefinitionLike, getAssetEntry, listAddresses } from "../../../../core/address.js";
import { compositionInputFingerprints } from "../../../../core/composition-resource.js";
import { computeDefinitionHash } from "../../../../core/definition-hash.js";
import { extractRefs } from "../../../../core/graph.js";
import { stableStringify } from "../../../../core/stable-stringify.js";
import type { AssetDefinition } from "../../../../core/types/index.js";
import { reloadVideoDefinition } from "../../../../core/loader.js";
import { StateManager } from "../../../../core/state/index.js";
import { applyDirectionSectionDecisions } from "../../../../core/direction-acceptance.js";
import { DIRECTION_SECTIONS } from "../../../../core/address.js";
import { ctx, initWorkspace, writeSilentWav } from "../../../__tests__/cli-fixtures.js";

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

export const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } }, lang: "en" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "hero", action: "she opens the door", setup: "front", lineup: [], duration: 2 },
      { id: "02", role: "pressure", action: "she steps through", setup: "front", lineup: [], join: "continuous", duration: 2 },
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
export const VIDEO_TSX = `import { Composition, Video, defineVideo, defineFalAsset, asset } from "konte";
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

// Shot 02's stem-driven motion placed through a trim of it.
export const TRIMMED_VIDEO_TSX = VIDEO_TSX.replace(
  "import { Composition, Video, defineVideo, defineFalAsset, asset }",
  "import { Composition, Video, adapters, defineVideo, defineFalAsset, asset }",
).replace(
  `      const motion = asset("motion", ia2v, {
        prompt: "she steps through",
        audio: animaticStage.shot("02").stem,
      });`,
  `      const raw = asset("raw", ia2v, {
        prompt: "she steps through",
        audio: animaticStage.shot("02").stem,
      });
      const motion = asset("motion", adapters.videoTrim, { source: raw, start: 0, duration: 2 });`,
);

// Shot 02 also plays the board's mix under its picture.
export const STEM_PLAYED_VIDEO_TSX = VIDEO_TSX.replace(
  "import { Composition, Video, defineVideo, defineFalAsset, asset }",
  "import { Audio, Composition, Video, defineVideo, defineFalAsset, asset }",
).replace(
  `      return <Composition><Video src={motion} /></Composition>;
    }),
  }),`,
  `      return <Composition><Video src={motion} /><Audio src={animaticStage.shot("02").stem} /></Composition>;
    }),
  }),`,
);

// The video's thumbnail: the cut's frame in shot 01, under a frame of its motion.
export const THUMBNAIL_VIDEO_TSX = VIDEO_TSX.replace(
  "import { Composition, Video, defineVideo, defineFalAsset, asset }",
  "import { Composition, Image, Video, adapters, defineVideo, defineFalAsset, asset }",
).replace(
  `      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});`,
  `      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
  thumbnail: {
    at: 1,
    compose: ({ shot, frame }) => {
      const still = asset("cover", adapters.videoFrame, { source: shot("01").video("motion"), at: 0.5 });
      return <Composition><Image src={frame} /><Image src={still} /></Composition>;
    },
  },
});`,
);

// The thumbnail's still drawing `cover` only through `fit`, an op built on it.
export const CHAINED_THUMBNAIL_VIDEO_TSX = THUMBNAIL_VIDEO_TSX.replace(
  "return <Composition><Image src={frame} /><Image src={still} /></Composition>;",
  `const fit = asset("fit", adapters.imageResize, { image: still, width: 64, height: 36 });
      return <Composition><Image src={frame} /><Image src={fit} /></Composition>;`,
);

// The video's thumbnail: the cut's frame at `at`, the cover itself.
export const frameThumbnailVideoTsx = (at: number): string =>
  VIDEO_TSX.replace(
    `      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});`,
    `      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
  thumbnail: { at: ${String(at)} },
});`,
  );

// One asset row of the review page — a per-shot take or an audio-track cue.
interface Row {
  address: string;
  variantId: string | null;
  variants?: Array<{ variantId: string; undecidedBesideAccepted?: boolean }>;
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
export async function generateAll(videoRoot: string): Promise<void> {
  // Always a reload: this stands in for a `generate` run after an edit, and a cached module would
  // generate against the definition the previous lap saw. Busting here leaves every later plain load
  // fresh too, the way the preview watcher's reload does.
  const defs = await loadPreviewDefinitions({
    videoRoot,
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
        const entry = getAssetEntry(definition, address);
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
export async function seed(
  manager: StateManager,
  address: string,
  mediaType: string,
): Promise<string> {
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
export async function settle(videoRoot: string, maxLaps = 5): Promise<number> {
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

export async function acceptAll(
  videoRoot: string,
  stage: "animatic" | "video" = "video",
  // A case about a decision that does not land reads the skips itself.
  opts: { allowSkipped?: boolean } = {},
): Promise<Record<string, unknown>> {
  const videoPath = path.join(videoRoot, "video.tsx");
  const defs = await loadPreviewDefinitions({ videoRoot, mode: "video-preview" });
  const reel = stage === "animatic" ? defs.animatic! : defs.video!;
  const stateRes = await handleGetReelState(
    {
      videoRoot,
      handoff: null,
      direction: defs.direction,
      animatic: defs.animatic,
      reference: null,
      downstreamVideo: null,
    },
    reel,
    "http://127.0.0.1/assets",
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
    thumbnail?: { needsReview: boolean; cover: Row; assets: Row[] };
  };

  const decisions: Record<string, string> = {};
  const displayedVariants: Record<string, string> = {};
  const displayedCandidates: Record<string, string[]> = {};
  // The reviewer takes the newest take an address offers and settles the rest — the gallery as the
  // page rendered it, so an accept decides against what it passed over rather than leaving a rival
  // standing (which would read as "needs review" forever).
  const choose = (row: Row): void => {
    const newest = row.variants?.find((v) => v.undecidedBesideAccepted)?.variantId ?? row.variantId;
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
  if (page.thumbnail)
    for (const row of [page.thumbnail.cover, ...page.thumbnail.assets]) choose(row);
  const thumbnailDecision = page.thumbnail?.needsReview ? "accepted" : undefined;

  const res = await handleReelSubmit(
    {
      videoRoot,
      handoff: null,
      direction: defs.direction,
      animatic: defs.animatic,
      reference: null,
      downstreamVideo: null,
    },
    async () => (stage === "animatic" ? defs.animatic! : reloadVideoDefinition(videoPath)),
    new Request(`http://127.0.0.1/api/${stage}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisions,
        displayedVariants,
        displayedCandidates,
        // Accept all marks the beds too, when the timeline has any.
        ...(page.timelineStem ? { timelineStemDecision: "accepted" } : {}),
        ...(thumbnailDecision ? { thumbnailDecision } : {}),
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
  if (!opts.allowSkipped) expect(payload.skippedDecisions ?? []).toEqual([]);
  return payload as Record<string, unknown>;
}

// One shot's verdict. `displayedVariants` stands in for a gallery pick — the take the reviewer was
// auditioning when they decided, which submit accepts in place of whatever the address resolves to.
export async function submitDecision(
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
  const defs = await loadPreviewDefinitions({ videoRoot, mode: "video-preview" });
  const stateRes = await handleGetReelState(
    {
      videoRoot,
      handoff: null,
      direction: defs.direction,
      animatic: defs.animatic,
      reference: null,
      downstreamVideo: null,
    },
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
  );
  const page = (await stateRes.json()) as {
    shots: Array<{ shotId: string; showingStandIn?: boolean }>;
  };
  const res = await handleReelSubmit(
    {
      videoRoot,
      handoff: null,
      direction: defs.direction,
      animatic: defs.animatic,
      reference: null,
      downstreamVideo: null,
    },
    async () => (stage === "animatic" ? defs.animatic! : reloadVideoDefinition(videoPath)),
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
export async function settledShotIds(
  videoRoot: string,
  stage: "animatic" | "video" = "video",
): Promise<string[]> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    mode: "video-preview",
  });
  const res = await handleGetReelState(
    // The board page is told the video, as the preview server tells it.
    {
      videoRoot,
      handoff: null,
      direction: defs.direction,
      animatic: defs.animatic,
      reference: null,
      downstreamVideo: stage === "animatic" ? defs.video : null,
    },
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
  );
  const page = (await res.json()) as {
    shots: Array<{ shotId: string; needsVerdict?: boolean; showingStandIn?: boolean }>;
  };
  // The client's own baseline (`baseShotAccepted`), minus the preview override this harness never
  // sets: a shot reading settled here is one Accept all skips.
  return page.shots.filter((s) => !s.showingStandIn && !s.needsVerdict).map((s) => s.shotId);
}

export async function reelPage(
  videoRoot: string,
  stage: "animatic" | "video",
): Promise<Array<{ shotId: string; notReady: boolean; needsVerdict?: boolean }>> {
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
    stage === "animatic" ? defs.animatic! : defs.video!,
    "http://127.0.0.1/assets",
  );
  return ((await res.json()) as { shots: Array<{ shotId: string; notReady: boolean }> }).shots;
}

export async function outstanding(
  videoRoot: string,
): Promise<{ needsReview: string[]; problems: string[]; remixes: string[] }> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
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
    remixes: (report.sections.find((s) => s.title === "Board stems to re-mix")?.items ?? []).map(
      (i) => i.address,
    ),
  };
}

export async function project(animaticLine = "here we go", videoTsx = VIDEO_TSX): Promise<string> {
  const inited = await initWorkspace(path.join(ctx.dir, "closure"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), animaticTsx(animaticLine));
  await fs.writeFile(path.join(videoRoot, "video.tsx"), videoTsx);
  await generateAll(videoRoot);
  return videoRoot;
}

// Sign the direction off whole, then write a waiver on a shot — what an agent does after a setup edit.
export async function waiveAfterWhole(videoRoot: string, key: string): Promise<void> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    mode: "video-preview",
  });
  const manager = await StateManager.load(videoRoot);
  manager.setDirectionAcceptance(
    applyDirectionSectionDecisions(
      defs.direction!,
      null,
      Object.fromEntries(DIRECTION_SECTIONS.map((s) => [s, true])),
    ),
  );
  await manager.save();
  await fs.writeFile(
    path.join(videoRoot, "direction.ts"),
    DIRECTION_TS.replace("  sequence: {", `  waivers: { "${key}": "one breath" },\n  sequence: {`),
  );
  await generateAll(videoRoot);
}
