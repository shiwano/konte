import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitShotStem,
  definitionHashForAddress,
  materializedLeafContentHash,
  prepareShotStem,
} from "../../../../core/composition-resource.js";
import { writeSilentWav } from "../../../../core/__tests__/helpers/wav.js";
import { JobManager } from "../../../../core/job-manager.js";
import { StateManager } from "../../../../core/state/index.js";
import type { CompositionClip } from "../../../../core/composition-builder.js";
import type { VideoDefinition } from "../../../../core/types/index.js";
import {
  acceptDisplayedStemSources,
  buildAudioAssets,
  materializedLeafReviewStatus,
  timelineStemVerdict,
  unlandedLeafReason,
  unlandedShotLeaves,
  unreleasedShotLeaves,
} from "../reel-review.js";
import { Audio, Composition, Image, Panel } from "../../../../core/dsl/composition/index.js";
import { defineComfyAsset } from "../../../../core/dsl/comfy-asset.js";
import { asset, defineAnimatic, defineVideo } from "../../../../core/dsl/index.js";
import {
  animaticTimeline,
  moves,
  shot,
  videoTimeline,
} from "../../../../core/__tests__/helpers/shot.js";
import { testDirection } from "../../../../core/__tests__/helpers/direction.js";

let dir: string;
let manager: StateManager;
let jobManager: JobManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-stem-review-"));
  manager = await StateManager.init(dir);
  jobManager = new JobManager(dir);
});

function addReadyVariant(address: string, file: string, definitionHash?: string): string {
  const vid = manager.reserveVariantId(address);
  const v = manager.getAssetState(address).variants![vid]!;
  v.file = file;
  if (definitionHash) v.definitionHash = definitionHash;
  return vid;
}

// The review status of a materialized leaf: unaccepted OR stale both count as needing review — the
// fix that stops a shot reading "done" while its audio (stem) was never signed off.
describe("materializedLeafReviewStatus", () => {
  const addr = "video:shot.01#stem";

  it("needs review when the leaf has no accepted variant", () => {
    addReadyVariant(addr, "stem.json", "h1"); // materialized but never accepted
    expect(materializedLeafReviewStatus(manager, addr, "h1")).toEqual({
      variantId: null,
      needsReview: true,
    });
  });

  it("does not need review when accepted and fresh", () => {
    const vid = addReadyVariant(addr, "stem.json", "h1");
    manager.setAccepted(addr, vid);
    expect(materializedLeafReviewStatus(manager, addr, "h1")).toEqual({
      variantId: vid,
      needsReview: false,
    });
  });

  it("needs review when the accepted variant is definition-stale", () => {
    const vid = addReadyVariant(addr, "stem.json", "h1");
    manager.setAccepted(addr, vid);
    // Current definition hash differs from the accepted variant's — definition-stale.
    expect(materializedLeafReviewStatus(manager, addr, "h2").needsReview).toBe(true);
  });
});

// The review's content baseline for a materialized leaf: a hash over (definitionHash,
// inputFingerprints). It must track the *resolved* upstream take — the reason the submit handler
// records it after the accepts, so a take accepted in that review folds into the baseline instead
// of reading as a later change.
describe("materializedLeafContentHash", () => {
  const bgm = "reference:bgm";
  const stemAddr = "video:timeline#stem";
  const video = {
    profiles: { main: { size: { width: 100, height: 100 } } },
    shots: [],
    timelineSoundtracks: [
      { __soundtrackEntry: true, id: "bed", src: { src: "__konte:reference:bgm__" }, options: {} },
    ],
  } as unknown as VideoDefinition;

  function addBgm(file: string, outputHash: string): string {
    const vid = manager.reserveVariantId(bgm);
    const v = manager.getAssetState(bgm).variants![vid]!;
    v.file = file;
    v.outputHash = outputHash;
    return vid;
  }

  it("is null when the stem's inputs do not resolve", () => {
    expect(materializedLeafContentHash(manager, video, stemAddr)).toBeNull();
  });

  it("changes when the resolved upstream take changes", () => {
    const a = addBgm("bgm-a.mp3", "out-a");
    manager.setAccepted(bgm, a);
    const hashA = materializedLeafContentHash(manager, video, stemAddr);
    expect(hashA).not.toBeNull();

    const b = addBgm("bgm-b.mp3", "out-b");
    manager.setAccepted(bgm, b);
    expect(materializedLeafContentHash(manager, video, stemAddr)).not.toBe(hashA);
  });
});

// Honoring the reviewer's audio take: the selected source variant becomes the accepted baseline,
// and a source's own consumed deps are cascaded (so it never depends on an unaccepted upstream).
describe("acceptDisplayedStemSources", () => {
  const video = { profiles: { main: {} }, shots: [] } as unknown as VideoDefinition;

  it("accepts the reviewer's displayed take (not the newest) for a stem source", async () => {
    const sfx = "video:shot.01.sfx";
    const chosen = addReadyVariant(sfx, "sfx-a.mp3");
    const passedOver = addReadyVariant(sfx, "sfx-b.mp3"); // a newer take, not chosen
    const accepted = await acceptDisplayedStemSources(
      manager,
      jobManager,
      ["video:shot.01.sfx"],
      { [sfx]: chosen },
      { [sfx]: [chosen, passedOver] },
      { video },
    );
    expect(accepted).toContain(sfx);
    expect(manager.getAcceptedVariant(sfx)).toBe(chosen);
    expect(manager.getAssetState(sfx).variants![passedOver]!.status).toBe("dismissed");
  });

  // Switching a source's accept: the take it moves off was on screen beside the chosen one, so it
  // is settled rather than left as a rival that keeps asking.
  it("dismisses the take it moves a source's accept off", async () => {
    const sfx = "video:shot.01.sfx";
    const first = addReadyVariant(sfx, "sfx-a.mp3");
    const second = addReadyVariant(sfx, "sfx-b.mp3");
    manager.setAccepted(sfx, first);

    await acceptDisplayedStemSources(
      manager,
      jobManager,
      ["video:shot.01.sfx"],
      { [sfx]: second },
      { [sfx]: [first, second] },
      { video },
    );

    expect(manager.getAcceptedVariant(sfx)).toBe(second);
    expect(manager.getAssetState(sfx).variants![first]!.status).toBe("dismissed");
  });

  // The shot's accept still settles the rivals under a source it did not have to move.
  it("dismisses the rivals of a source whose accept already stands", async () => {
    const sfx = "video:shot.01.sfx";
    const chosen = addReadyVariant(sfx, "sfx-a.mp3");
    const passedOver = addReadyVariant(sfx, "sfx-b.mp3");
    manager.setAccepted(sfx, chosen);

    const accepted = await acceptDisplayedStemSources(
      manager,
      jobManager,
      ["video:shot.01.sfx"],
      { [sfx]: chosen },
      { [sfx]: [chosen, passedOver] },
      { video },
    );
    expect(accepted).toEqual([]);
    expect(manager.getAssetState(sfx).variants![passedOver]!.status).toBe("dismissed");
  });

  it("cascades a pre-accepted source's own consumed deps", async () => {
    const sfx = "video:shot.01.sfx";
    const upstream = "video:shot.01.voice";
    const upstreamVid = addReadyVariant(upstream, "voice.mp3");
    const chosen = addReadyVariant(sfx, "sfx.mp3");
    await jobManager.createJob({
      address: sfx,
      variantId: chosen,
      resolvedDeps: { "video:shot.01.voice": "voice.mp3" },
      backendKind: "comfy",
    });
    await acceptDisplayedStemSources(
      manager,
      jobManager,
      ["video:shot.01.sfx"],
      { [sfx]: chosen },
      {},
      {
        video,
      },
    );
    // The source's consumed upstream is accepted too, not left dangling.
    expect(manager.getAcceptedVariant(upstream)).toBe(upstreamVid);
  });

  it("is a no-op when the source has no displayed selection", async () => {
    const sfx = "video:shot.01.sfx";
    addReadyVariant(sfx, "sfx.mp3");
    const accepted = await acceptDisplayedStemSources(
      manager,
      jobManager,
      ["video:shot.01.sfx"],
      {},
      {},
      { video },
    );
    expect(accepted).toEqual([]);
    expect(manager.getAcceptedVariant(sfx)).toBeNull();
  });
});

// A per-shot audio cue routes its accept to its owning shot via a server-provided shotId — even
// when its source is a reference/timeline asset whose address carries no shot segment.
describe("buildAudioAssets shotId tagging", () => {
  const video = {
    profiles: { main: {} },
    shots: [{ id: "01", duration: 1 }],
    timelineSoundtracks: [
      { __soundtrackEntry: true, id: "bed", src: { src: "__konte:reference:bgm__" }, options: {} },
    ],
  } as unknown as VideoDefinition;

  const audioClip = (address: string): CompositionClip => ({
    assetName: null,
    address,
    mediaType: "audio",
    start: 0,
    end: 1,
    mediaStart: null,
    volume: null,
    hasAudio: true,
    cueId: null,
  });

  function build(clipsByShot: Map<string, CompositionClip[]>) {
    return buildAudioAssets({
      manager,
      video,
      clipsByShot,
      totalDuration: 2,
      shotOffsets: [
        { shotId: "01", startTime: 0, duration: 1 },
        { shotId: "02", startTime: 1, duration: 1 },
      ],
      preBuilt: new Map(
        ["reference:sfx", "reference:bgm", "video:shot.01.sfx", "video:shot.02.sfx"].map(
          (address) => [
            address,
            {
              assetName: address,
              address,
              variantId: "v1",
              variantStatus: "none" as const,
              hasNewerVariant: false,
              variants: [],
            },
          ],
        ),
      ),
      buildAsset: (assetName, address) => ({
        assetName,
        address,
        variantId: "v1",
        variantStatus: "none" as const,
        hasNewerVariant: false,
        variants: [],
      }),
    });
  }

  it("tags a per-shot cue with its shot even when the source is a reference asset", async () => {
    // resolve the bed so it doesn't drop off the track
    const bgmVid = addReadyVariant("reference:bgm", "bgm.mp3");
    manager.setAccepted("reference:bgm", bgmVid);
    const out = build(new Map([["01", [audioClip("reference:sfx")]]]));
    const sfx = out.find((a) => a.address === "reference:sfx");
    expect(sfx?.cues.map((c) => c.shotId)).toEqual(["01"]);
    const bed = out.find((a) => a.kind === "soundtrack");
    expect(bed?.cues.every((c) => c.shotId === undefined)).toBe(true);
  });

  it("tags every cue of an asset shared across shots with the shot that placed it", () => {
    const out = build(
      new Map([
        ["01", [audioClip("reference:sfx")]],
        ["02", [audioClip("reference:sfx")]],
      ]),
    );
    const sfx = out.find((a) => a.address === "reference:sfx");
    expect(sfx?.cues.map((c) => c.shotId)).toEqual(["01", "02"]);
  });
});

// The animatic accept is what opens the spend gate, so it has to be all-or-nothing: a leaf whose own
// refs do not resolve is refused, and nothing it would have signed off may be left accepted behind it.
describe("unlandedShotLeaves", () => {
  const pictureComfy = defineComfyAsset({
    workflow: "image.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });
  const voiceComfy = defineComfyAsset({
    workflow: "audio.json",
    description: "test adapter",
    inputs: { text: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });
  const withAudio = defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
    }),
    {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", pictureComfy, { prompt: "a cat walking" });
              const vo = asset("vo", voiceComfy, { text: "hello" });
              return (
                <Composition>
                  <Image src={motion} />
                  <Audio src={vo} />
                </Composition>
              );
            },
          }),
        ]),
    },
  );

  const planShot = { shotId: "01", pending: false, shotFn: () => null };

  function acceptLeaf(address: string, defHash: string | null): string {
    const vid = manager.reserveVariantId(address);
    const v = manager.getAssetState(address).variants![vid]!;
    v.file = `${address}.json`;
    v.definitionHash = defHash;
    manager.setAccepted(address, vid);
    return vid;
  }

  // The takes the two leaves are built from. A leaf can only be signed off while these resolve —
  // the materializers refuse otherwise — so every case below starts from a shot that CAN be
  // materialized, and the one that takes it away says so.
  function readyRefs(): void {
    addReadyVariant("video:shot.01.motion", "motion.mp4");
    addReadyVariant("video:shot.01.vo", "vo.wav");
  }

  function acceptBothLeaves(): void {
    acceptLeaf(
      "video:shot.01#composition",
      definitionHashForAddress(withAudio, "video:shot.01#composition"),
    );
    acceptLeaf("video:shot.01#stem", definitionHashForAddress(withAudio, "video:shot.01#stem"));
  }

  it("reports both halves when neither leaf was ever accepted", () => {
    readyRefs();
    expect(unlandedShotLeaves(manager, withAudio, planShot).map((l) => l.address)).toEqual([
      "video:shot.01#composition",
      "video:shot.01#stem",
    ]);
  });

  it("reports nothing once both leaves are accepted at their current definitions", () => {
    readyRefs();
    acceptBothLeaves();
    expect(unlandedShotLeaves(manager, withAudio, planShot)).toEqual([]);
  });

  it("reports the stem alone when only the audio half failed to land", () => {
    readyRefs();
    acceptLeaf(
      "video:shot.01#composition",
      definitionHashForAddress(withAudio, "video:shot.01#composition"),
    );
    expect(unlandedShotLeaves(manager, withAudio, planShot).map((l) => l.address)).toEqual([
      "video:shot.01#stem",
    ]);
  });

  // The reason the check asks `needsReview` instead of "is anything accepted?": an accept left over
  // from an earlier review, which this one failed to refresh, will be asked for again next time.
  it("reports a leaf whose leftover accept is stale, though an accepted variant exists", () => {
    readyRefs();
    acceptLeaf("video:shot.01#composition", "a-hash-from-an-older-definition");
    acceptLeaf("video:shot.01#stem", definitionHashForAddress(withAudio, "video:shot.01#stem"));
    expect(unlandedShotLeaves(manager, withAudio, planShot).map((l) => l.address)).toEqual([
      "video:shot.01#composition",
    ]);
  });

  // Staleness reads an input that resolves to nothing as "not determinable" rather than changed, so
  // this leftover reports perfectly fresh — while the materializers, which refuse on an unresolvable
  // ref, had just declined to rebuild it. Readiness is the half of the test that catches it.
  it("reports a leaf whose leftover accept is fresh but whose input no longer resolves", () => {
    readyRefs();
    acceptBothLeaves();
    expect(unlandedShotLeaves(manager, withAudio, planShot)).toEqual([]);

    // The takes go away (a clean, a prune, a definition pointed elsewhere).
    manager.getAssetState("video:shot.01.motion").variants = {};
    manager.getAssetState("video:shot.01.vo").variants = {};

    expect(unlandedShotLeaves(manager, withAudio, planShot).map((l) => l.address)).toEqual([
      "video:shot.01#composition",
      "video:shot.01#stem",
    ]);
  });

  it("reports nothing for a pendingShot — its decision is a no-op, not a miss", () => {
    expect(
      unlandedShotLeaves(manager, withAudio, { shotId: "01", pending: true, shotFn: null }),
    ).toEqual([]);
  });

  describe("a shot whose last cue was removed", () => {
    const silent = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Image src={asset("motion", pictureComfy, { prompt: "a cat walking" })} />
                </Composition>
              ),
            }),
          ]),
      },
    );
    const stemAddress = "video:shot.01#stem";

    it("asks for the stem while its accept over the removed audio stands", () => {
      readyRefs();
      acceptBothLeaves();
      expect(unlandedShotLeaves(manager, silent, planShot).map((l) => l.address)).toEqual([
        stemAddress,
      ]);
      expect(
        materializedLeafReviewStatus(
          manager,
          stemAddress,
          definitionHashForAddress(silent, stemAddress),
        ).needsReview,
      ).toBe(true);
    });

    it("settles once that stem is released", () => {
      readyRefs();
      acceptBothLeaves();
      manager.setUnaccepted(stemAddress, manager.getAcceptedVariant(stemAddress)!);
      expect(unlandedShotLeaves(manager, silent, planShot)).toEqual([]);
    });

    it("asks for no stem on a shot that never sounded anything", () => {
      readyRefs();
      acceptLeaf(
        "video:shot.01#composition",
        definitionHashForAddress(silent, "video:shot.01#composition"),
      );
      expect(unlandedShotLeaves(manager, silent, planShot)).toEqual([]);
    });
  });

  // What the reviewer is left with when a leaf does not land. The generic "check that every asset it
  // references resolves" named nothing, so the address that held the leaf back was found by opening
  // `status -v` beside the record; each case here is a reason that carries it.
  describe("unlandedLeafReason", () => {
    const stem = { address: "video:shot.01#stem", what: "the audio stem" };
    const composition = { address: "video:shot.01#composition", what: "the composition" };

    // The reported case: a take rerolled out from under a leaf, whose input is stale as a result.
    it("names the stale input, its cause and the generate that clears it", () => {
      const motion = addReadyVariant("video:shot.01.motion", "motion.mp4");
      manager.getAssetState("video:shot.01.motion").variants![motion]!.outputHash = "new";
      const vo = addReadyVariant("video:shot.01.vo", "vo.wav");
      manager.getAssetState("video:shot.01.vo").variants![vo]!.inputFingerprints = {
        "video:shot.01.motion": "old",
      };

      expect(unlandedLeafReason(manager, withAudio, stem)).toBe(
        [
          "the audio stem could not be materialized; these inputs have no take a spend may use:",
          "video:shot.01.vo (input-stale: video:shot.01.motion)",
          "konte generate video",
        ].join("\n"),
      );
    });

    // A human accept resolves however stale it is, so it never reaches this list — the ref that does
    // is the reviewer's own reroll, still undecided.
    it("says nothing about an input whose stale take is the accepted one", () => {
      readyRefs();
      const vo = manager.getAssetState("video:shot.01.vo").variants!;
      const voId = Object.keys(vo)[0]!;
      vo[voId]!.inputFingerprints = { "video:shot.01.motion": "old" };
      const motion = manager.getAssetState("video:shot.01.motion").variants!;
      motion[Object.keys(motion)[0]!]!.outputHash = "new";
      manager.setAccepted("video:shot.01.vo", voId);

      expect(unlandedLeafReason(manager, withAudio, stem)).toBe(
        [
          "the audio stem still needs review — the accept did not land and reported no error",
          "konte inspect video:shot.01#stem",
        ].join("\n"),
      );
    });

    it("says so when the input has no take at all", () => {
      addReadyVariant("video:shot.01.motion", "motion.mp4");

      expect(unlandedLeafReason(manager, withAudio, stem)).toBe(
        [
          "the audio stem could not be materialized; these inputs have no take a spend may use:",
          "video:shot.01.vo (no take yet)",
          "konte generate video",
        ].join("\n"),
      );
    });

    it("says so when every take of the input was dismissed", () => {
      readyRefs();
      const vo = manager.getAssetState("video:shot.01.vo").variants!;
      vo[Object.keys(vo)[0]!]!.status = "dismissed";

      expect(unlandedLeafReason(manager, withAudio, stem)).toBe(
        [
          "the audio stem could not be materialized; these inputs have no take a spend may use:",
          "video:shot.01.vo (every take was dismissed)",
          "konte generate video",
        ].join("\n"),
      );
    });

    // The other half of `leafLanded`, and a different place to send the reader: nothing upstream is
    // missing, the leaf's own leftover accept aged out.
    it("points at the leaf's own re-accept when its refs all resolve", () => {
      readyRefs();
      acceptLeaf("video:shot.01#composition", "a-hash-from-an-older-definition");

      expect(unlandedLeafReason(manager, withAudio, composition)).toBe(
        [
          "the composition still needs review — the accepted take is definition-stale",
          "konte accept video:shot.01#composition",
        ].join("\n"),
      );
    });

    it("says the accept simply did not land when nothing else explains it", () => {
      readyRefs();

      expect(unlandedLeafReason(manager, withAudio, composition)).toBe(
        [
          "the composition still needs review — the accept did not land and reported no error",
          "konte inspect video:shot.01#composition",
        ].join("\n"),
      );
    });
  });
});

// The board's stem is a leaf like the delivered one: never generated, materialized by the shot's
// accept over the line it signs off, and re-opened with the composition once that line is re-picked.
describe("unlandedShotLeaves — the board's stem", () => {
  const still = defineComfyAsset({
    workflow: "still.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });
  const tts = defineComfyAsset({
    workflow: "tts.json",
    description: "test adapter",
    inputs: { text: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });
  const board = defineAnimatic(
    testDirection({
      fps: 30,
      size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
    }),
    {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", still, { prompt: "a cat" })} {...moves} />
                <Audio src={asset("vo", tts, { text: "hello" })} />
              </Composition>
            ),
          }),
        ]),
    },
  );
  const planShot = { shotId: "01", pending: false, shotFn: () => null };
  const vo = "animatic:shot.01.vo";
  const stem = "animatic:shot.01#stem";
  const composition = "animatic:shot.01#composition";

  // A take of the line, accepted, with the bytes a mix would fingerprint.
  function pickLine(outputHash: string): string {
    const vid = addReadyVariant(vo, `${outputHash}.wav`);
    manager.getAssetState(vo).variants![vid]!.outputHash = outputHash;
    manager.setAccepted(vo, vid);
    return vid;
  }

  // A mix materialized over the line whose bytes are `over` — stale once another line is picked.
  function mixOver(over: string): string {
    const vid = addReadyVariant(stem, "stem.wav", definitionHashForAddress(board, stem)!);
    manager.getAssetState(stem).variants![vid]!.inputFingerprints = { [vo]: over };
    return vid;
  }

  // The board's composition fingerprints its audio too (its identity covers the sound), so it is
  // accepted over the same line as the mix.
  function acceptComposition(over: string): void {
    const vid = manager.reserveVariantId(composition);
    const v = manager.getAssetState(composition).variants![vid]!;
    v.file = "composition.html";
    v.definitionHash = definitionHashForAddress(board, composition);
    v.inputFingerprints = { [vo]: over };
    manager.setAccepted(composition, vid);
  }

  it("lands while the accepted mix covers the picked line", () => {
    addReadyVariant("animatic:shot.01.first", "first.png");
    pickLine("old");
    manager.setAccepted(stem, mixOver("old"));
    acceptComposition("old");
    expect(unlandedShotLeaves(manager, board, planShot)).toEqual([]);
  });

  it("re-opens the stem with the composition once the line is re-picked", () => {
    addReadyVariant("animatic:shot.01.first", "first.png");
    pickLine("old");
    manager.setAccepted(stem, mixOver("old"));
    acceptComposition("old");
    pickLine("new");
    expect(unlandedShotLeaves(manager, board, planShot).map((m) => m.address)).toEqual([
      composition,
      stem,
    ]);
  });

  it("asks for the stem while no accept has materialized one", () => {
    addReadyVariant("animatic:shot.01.first", "first.png");
    pickLine("only");
    acceptComposition("only");
    expect(unlandedShotLeaves(manager, board, planShot)).toEqual([
      { address: stem, what: "the audio stem" },
    ]);
  });
});

// The board's mix runs outside the state lock and is recorded under it, so the commit has to stand
// on its own: the takes it was mixed from must still be the ones resolving, and a failure after the
// variant is reserved must leave no file-less take behind.
describe("prepareShotStem / commitShotStem — the board's mix", () => {
  const still = defineComfyAsset({
    workflow: "still.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });
  const tts = defineComfyAsset({
    workflow: "tts.json",
    description: "test adapter",
    inputs: { text: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "audio" } },
  });
  const board = defineAnimatic(
    testDirection({
      fps: 30,
      size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
    }),
    {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 1,
            build: () => (
              <Composition>
                <Panel src={asset("first", still, { prompt: "a cat" })} {...moves} />
                <Audio src={asset("vo", tts, { text: "hello" })} />
              </Composition>
            ),
          }),
        ]),
    },
  );
  const vo = "animatic:shot.01.vo";
  const stem = "animatic:shot.01#stem";

  async function recordLine(name: string): Promise<string> {
    await writeSilentWav(path.join(dir, "assets", `${name}.wav`));
    const vid = addReadyVariant(vo, `assets/${name}.wav`);
    manager.getAssetState(vo).variants![vid]!.outputHash = name;
    manager.setAccepted(vo, vid);
    return vid;
  }

  it("mixes to a real file and records it with its measurements", async () => {
    await recordLine("one");
    const prepared = await prepareShotStem({ manager, video: board, address: stem });
    expect(prepared?.kind).toBe("mix");
    const variantId = await commitShotStem({
      manager,
      video: board,
      address: stem,
      prepared: prepared!,
    });
    const v = manager.getAssetState(stem).variants![variantId!]!;
    expect(v.file).toMatch(/stem\.wav$/);
    await fs.access(path.join(dir, v.file!));
    expect(v.media?.kind).toBe("audio");
    expect(v.inputFingerprints).toEqual({ [vo]: "one" });
    // The staging is gone, and an unchanged accept reuses the take.
    expect(await fs.readdir(path.join(dir, ".konte", "cache"))).toEqual([]);
    const again = await prepareShotStem({ manager, video: board, address: stem });
    expect(again).toMatchObject({ kind: "existing", variantId });
  });

  it("refuses a mix whose line was re-picked between the mix and the commit", async () => {
    await recordLine("one");
    const prepared = await prepareShotStem({ manager, video: board, address: stem });
    await recordLine("two");
    await expect(
      commitShotStem({ manager, video: board, address: stem, prepared: prepared! }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_NOT_RESOLVED" });
    expect(manager.tryGetAssetState(stem)?.variants ?? {}).toEqual({});
    expect(await fs.readdir(path.join(dir, ".konte", "cache"))).toEqual([]);
  });

  it("refuses a reused mix the same way once its line was re-picked", async () => {
    await recordLine("one");
    const first = await prepareShotStem({ manager, video: board, address: stem });
    const variantId = await commitShotStem({
      manager,
      video: board,
      address: stem,
      prepared: first!,
    });
    const reused = await prepareShotStem({ manager, video: board, address: stem });
    expect(reused?.kind).toBe("existing");
    await recordLine("two");
    await expect(
      commitShotStem({ manager, video: board, address: stem, prepared: reused! }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_NOT_RESOLVED" });
    expect(Object.keys(manager.getAssetState(stem).variants!)).toEqual([variantId]);
  });

  it("rolls the reserved variant back when the file cannot be placed", async () => {
    await recordLine("one");
    const prepared = await prepareShotStem({ manager, video: board, address: stem });
    // The stem's asset dir is a file, so the variant dir cannot be made.
    await fs.mkdir(path.join(dir, "assets", "animatic"), { recursive: true });
    await fs.writeFile(path.join(dir, "assets", "animatic", "shot.01#stem"), "");
    await expect(
      commitShotStem({ manager, video: board, address: stem, prepared: prepared! }),
    ).rejects.toThrow();
    expect(manager.tryGetAssetState(stem)?.variants ?? {}).toEqual({});
    expect(await fs.readdir(path.join(dir, ".konte", "cache"))).toEqual([]);
  });
});

// The beds' verdict, settled the same way a shot's is. Both halves matter: an accept that failed to
// materialize must not be recorded, and neither must a verdict on beds that no longer exist.
describe("timelineStemVerdict", () => {
  const bgm = "reference:bgm";
  const stemAddr = "video:timeline#stem";
  const withBeds = {
    stage: "video",
    shots: [],
    timelineSoundtracks: [
      { __soundtrackEntry: true, id: "bed", src: { src: "__konte:reference:bgm__" }, options: {} },
    ],
  } as unknown as VideoDefinition;
  // The same video after the reviewer's beds were taken out of video.tsx mid-review.
  const withoutBeds = { ...withBeds, timelineSoundtracks: [] } as unknown as VideoDefinition;

  function acceptStem(): void {
    const vid = addReadyVariant(
      stemAddr,
      "stem.json",
      definitionHashForAddress(withBeds, stemAddr) ?? undefined,
    );
    manager.setAccepted(stemAddr, vid);
  }

  it("records nothing when the review had no verdict on the beds", () => {
    expect(timelineStemVerdict(manager, withBeds, undefined)).toEqual({
      landed: undefined,
      skipped: null,
    });
  });

  it("records an accept that materialized", () => {
    addReadyVariant(bgm, "bgm.mp3");
    acceptStem();
    expect(timelineStemVerdict(manager, withBeds, "accepted")).toEqual({
      landed: "accepted",
      skipped: null,
    });
  });

  it("reports an accept that did not materialize, and records no verdict", () => {
    addReadyVariant(bgm, "bgm.mp3"); // the bed resolves, but the stem was never accepted
    const verdict = timelineStemVerdict(manager, withBeds, "accepted");
    expect(verdict.landed).toBeUndefined();
    expect(verdict.skipped?.address).toBe(stemAddr);
  });

  // The beds are the timeline stem's inputs, and a bed lives in another stage — so the generate the
  // reason names is the bed's, not the reviewed stage's.
  it("names the bed that held the stem back, and the stage it is generated in", () => {
    const verdict = timelineStemVerdict(manager, withBeds, "accepted");
    expect(verdict.skipped?.reason).toBe(
      [
        "the timeline audio stem could not be materialized; these inputs have no take a spend may use:",
        "reference:bgm (no take yet)",
        "konte generate reference",
      ].join("\n"),
    );
  });

  it("records a release that took", () => {
    addReadyVariant(bgm, "bgm.mp3");
    expect(timelineStemVerdict(manager, withBeds, "none")).toEqual({
      landed: "none",
      skipped: null,
    });
  });

  it("reports a release that did not take", () => {
    addReadyVariant(bgm, "bgm.mp3");
    acceptStem();
    const verdict = timelineStemVerdict(manager, withBeds, "none");
    expect(verdict.landed).toBeUndefined();
    expect(verdict.skipped?.reason).toContain("still accepted");
  });

  // A verdict on beds that are gone is not an outcome — and not a failure to report either, since
  // the accept block is gated on the beds too and never ran.
  it("drops either verdict when the beds were removed while the review was open", () => {
    addReadyVariant(bgm, "bgm.mp3");
    acceptStem();
    expect(timelineStemVerdict(manager, withoutBeds, "accepted")).toEqual({
      landed: undefined,
      skipped: null,
    });
    expect(timelineStemVerdict(manager, withoutBeds, "none")).toEqual({
      landed: undefined,
      skipped: null,
    });
  });
});

// The release's mirror. `unacceptReelShots` swallows per-address failures the same way the accept
// blocks do, so a "none" is confirmed by reading state — over the addresses the RELEASE targeted,
// which include the shot's own per-asset takes, not just its leaves.
describe("unreleasedShotLeaves", () => {
  const pictureComfy = defineComfyAsset({
    workflow: "image.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });
  const video = defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
    }),
    {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", pictureComfy, { prompt: "a cat walking" });
              return (
                <Composition>
                  <Image src={motion} />
                </Composition>
              );
            },
          }),
        ]),
    },
  );

  const planShot = {
    shotId: "01",
    pending: false,
    shotFn: () => null,
    resolvedVariants: {} as Record<string, string>,
  };

  function accept(address: string): string {
    const vid = addReadyVariant(address, `${address}.bin`);
    manager.setAccepted(address, vid);
    return vid;
  }

  it("reports nothing once every target is released", () => {
    expect(unreleasedShotLeaves(manager, video, planShot)).toEqual([]);
  });

  it("reports a leaf whose release did not take", () => {
    accept("video:shot.01#composition");
    expect(unreleasedShotLeaves(manager, video, planShot).map((l) => l.address)).toEqual([
      "video:shot.01#composition",
    ]);
  });

  // The half that checking leaves alone would miss: the release targets the shot's own takes too.
  it("reports a per-asset take whose release did not take", () => {
    const vid = accept("video:shot.01.motion");
    expect(
      unreleasedShotLeaves(manager, video, {
        ...planShot,
        resolvedVariants: { motion: vid },
      }).map((l) => l.address),
    ).toEqual(["video:shot.01.motion"]);
  });

  // Audio rides its stem, so the release never targets it per-asset and neither does the check.
  it("ignores an audio take, which the release leaves to the stem", () => {
    const vid = manager.reserveVariantId("video:shot.01.vo");
    const v = manager.getAssetState("video:shot.01.vo").variants![vid]!;
    v.file = "vo.wav";
    manager.setAccepted("video:shot.01.vo", vid);
    expect(
      unreleasedShotLeaves(manager, video, { ...planShot, resolvedVariants: { vo: vid } }),
    ).toEqual([]);
  });
});
