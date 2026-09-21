import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DefinitionLike } from "../../../../core/address.js";
import {
  compositionDefinitionHashForAddress,
  materializedLeafContentHash,
} from "../../../../core/composition-resource.js";
import { directionPartHashes } from "../../../../core/direction-hash.js";
import type { Direction } from "../../../../core/dsl/direction.js";
import type { ReviewRecord } from "../../../../core/review-record.js";
import { StateManager } from "../../../../core/state/manager.js";
import type { ReferenceDefinition, VideoDefinition } from "../../../../core/types/index.js";
import {
  collectAllAddresses,
  collectAllDirectionAddresses,
  collectAllReferenceAddresses,
  collectChangedAddresses,
  collectChangedDirectionAddresses,
  collectChangedReferenceAddresses,
} from "../handoff.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-handoff-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The address is absent from this stub, so definitionHashForAddress resolves to
// null — definition-staleness is out of scope here; input-stale and pending
// detection don't need it.
const STAGE_DEF: DefinitionLike = {
  shots: [],
  topLevelAssets: {},
};

const SHOTS = [{ id: "02", assets: { motion: {} } }];

// A def whose shot 02 carries a real shotFn, so composition definition-staleness
// can be computed against its live hash. Cast because DefinitionLike's shot type
// omits shotFn (read only by the composition-hash path, which sees a VideoDefinition).
function makeVideoDef(shotFn: () => unknown[]): VideoDefinition {
  return {
    shots: [
      {
        id: "02",
        duration: 5,
        action: "test shot",
        assets: { motion: {} },
        shotFn,
        compositionRefs: [],
      },
    ],
    topLevelAssets: {},
    stage: "video" as const,
    format: { size: { width: 1920, height: 1080 }, fps: 30 },
    typography: { lang: "en" as const },
  } as unknown as VideoDefinition;
}

const REVIEW_AT = "2026-06-01T00:00:00.000Z";
const READY_AFTER = "2026-06-02T00:00:00.000Z";
const READY_BEFORE = "2026-05-01T00:00:00.000Z";

// Mirror the production commit: a variant becomes ready when its file lands, which
// also stamps `readyAt`. Defaults to after the review so the common "fresh reroll"
// case is ready; pass an earlier `readyAt` to model a leftover pre-review candidate.
function setFile(
  mgr: StateManager,
  addr: string,
  variantId: string,
  file: string,
  readyAt: string = READY_AFTER,
): void {
  const v = mgr.ensureAssetState(addr).variants?.[variantId];
  if (v) {
    v.file = file;
    v.readyAt = readyAt;
  }
}

function makeRecord(reviewedMotionId: string): ReviewRecord {
  return {
    mode: "video-preview",
    stage: "video",
    createdAt: REVIEW_AT,
    context: { shots: [{ shotId: "02", duration: 5, variants: { motion: reviewedMotionId } }] },
    decisions: [],
  };
}

describe("collectChangedAddresses", () => {
  const addr = "video:shot.02.motion";

  it("flags an asset with a fresh unreviewed ready variant from a reroll", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.mp4");
    mgr.setAccepted(addr, vOld);
    // Reroll output: ready (has a file) but undecided, and accepted-still-wins
    // resolution keeps vOld resolved — so only the new-variant signal catches it.
    const vNew = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vNew, "new.mp4");

    const changed = collectChangedAddresses(SHOTS, "video", mgr, STAGE_DEF, makeRecord(vOld));

    expect(changed).toEqual(["video:shot.02.motion"]);
  });

  it("reports no changes when the accepted variant still matches the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.mp4");
    mgr.setAccepted(addr, vOld);

    const changed = collectChangedAddresses(SHOTS, "video", mgr, STAGE_DEF, makeRecord(vOld));

    expect(changed).toEqual([]);
  });

  it("does not flag a leftover ready candidate that became ready before the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.mp4", READY_BEFORE);
    mgr.setAccepted(addr, vOld);
    // An undecided ready variant that predates the review: a candidate the human
    // already saw and passed on, not a fresh reroll. Gating on readyAt keeps it out.
    const vLeftover = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vLeftover, "leftover.mp4", READY_BEFORE);

    const changed = collectChangedAddresses(SHOTS, "video", mgr, STAGE_DEF, makeRecord(vOld));

    expect(changed).toEqual([]);
  });

  it("flags a shot's composition when its accepted variant went definition-stale", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.mp4");
    mgr.setAccepted(addr, vOld);

    // Accepted composition baseline from the last review, recorded with the hash
    // its shotFn had then. The def below carries a different shotFn, so its live
    // composition hash diverges → definition-stale → "composition changed".
    const compAddr = "video:shot.02#composition";
    const vComp = mgr.reserveVariantId(compAddr);
    setFile(mgr, compAddr, vComp, "composition.html");
    const comp = mgr.ensureAssetState(compAddr).variants?.[vComp];
    if (comp) comp.definitionHash = "stale00000000";
    mgr.setAccepted(compAddr, vComp);

    const shotFn = () => [];
    const def = makeVideoDef(shotFn);

    const changed = collectChangedAddresses(
      [{ id: "02", assets: { motion: {} }, shotFn }],
      "video",
      mgr,
      def,
      makeRecord(vOld),
    );

    expect(changed).toEqual(["video:shot.02#composition"]);
  });

  it("flags a shot absent from the review whose fresh variant landed after it", async () => {
    const mgr = await StateManager.init(tmpDir);
    // Shot 03 was added to the definition after the last review (which only saw 02),
    // so it has no baseline — but its freshly generated motion is exactly what the
    // note should cover.
    const newAddr = "video:shot.03.motion";
    const vNew = mgr.reserveVariantId(newAddr);
    setFile(mgr, newAddr, vNew, "new.mp4");

    const changed = collectChangedAddresses(
      [{ id: "03", assets: { motion: {} } }],
      "video",
      mgr,
      STAGE_DEF,
      makeRecord("v-reviewed02"),
    );

    expect(changed).toEqual(["video:shot.03.motion"]);
  });

  it("flags a new shot's composition materialized after the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    // A brand-new shot's composition auto-materializes to a ready, unaccepted variant.
    // With no accepted baseline, staleness can't catch it — the fresh-ready signal must.
    const compAddr = "video:shot.03#composition";
    const vComp = mgr.reserveVariantId(compAddr);
    setFile(mgr, compAddr, vComp, "composition.html");

    const changed = collectChangedAddresses(
      [{ id: "03", assets: {}, shotFn: () => [] }],
      "video",
      mgr,
      STAGE_DEF,
      makeRecord("v-reviewed02"),
    );

    expect(changed).toEqual(["video:shot.03#composition"]);
  });

  it("does not flag a composition whose ready variant predates the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    // A materialized-but-unaccepted composition the reviewer already saw and passed on:
    // ready before the review, never accepted. With no reviewed baseline recorded for
    // compositions, the readyAt gate is the only guard — it must keep this out.
    const compAddr = "video:shot.02#composition";
    const vComp = mgr.reserveVariantId(compAddr);
    setFile(mgr, compAddr, vComp, "composition.html", READY_BEFORE);

    const changed = collectChangedAddresses(
      [{ id: "02", assets: {}, shotFn: () => [] }],
      "video",
      mgr,
      STAGE_DEF,
      makeRecord("v-reviewed02"),
    );

    expect(changed).toEqual([]);
  });

  it("flags a timeline bed with a fresh unreviewed ready variant", async () => {
    const mgr = await StateManager.init(tmpDir);
    const bgmAddr = "video:timeline.bgm";
    const vOld = mgr.reserveVariantId(bgmAddr);
    setFile(mgr, bgmAddr, vOld, "old.mp3");
    mgr.setAccepted(bgmAddr, vOld);
    const vNew = mgr.reserveVariantId(bgmAddr);
    setFile(mgr, bgmAddr, vNew, "new.mp3");

    const def = {
      shots: [],
      topLevelAssets: {
        bgm: { deterministic: false },
      },
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
    } as unknown as DefinitionLike;
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: REVIEW_AT,
      context: { shots: [], timeline: { bgm: vOld } },
      decisions: [],
    };

    const changed = collectChangedAddresses([], "video", mgr, def, record);
    expect(changed).toEqual(["video:timeline.bgm"]);
  });

  it("flags a shot's stem materialized after the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const stemAddr = "video:shot.02#stem";
    const vStem = mgr.reserveVariantId(stemAddr);
    setFile(mgr, stemAddr, vStem, "stem.wav");

    const changed = collectChangedAddresses(
      [{ id: "02", assets: {}, shotFn: () => [], stemRefs: ["video:shot.02.motion"] }],
      "video",
      mgr,
      STAGE_DEF,
      makeRecord("v-reviewed02"),
    );

    expect(changed).toEqual(["video:shot.02#stem"]);
  });

  const TIMELINE_STEM_DEF = {
    shots: [],
    topLevelAssets: {},
    timelineSoundtracks: [{ __soundtrackEntry: true, id: "bed", src: { src: "x" }, options: {} }],
    stage: "video" as const,
    format: { size: { width: 1920, height: 1080 }, fps: 30 },
    typography: { lang: "en" as const },
  } as unknown as DefinitionLike;

  function makeStemRecord(contentHashes?: Record<string, string>): ReviewRecord {
    return {
      mode: "video-preview",
      stage: "video",
      createdAt: REVIEW_AT,
      context: { shots: [], timeline: {}, ...(contentHashes ? { contentHashes } : {}) },
      decisions: [],
    };
  }

  it("flags the timeline stem when its content diverges from the review baseline", async () => {
    const mgr = await StateManager.init(tmpDir);
    // The reviewer's audio fingerprint recorded at submit; the live bed since changed (swap /
    // volume), so its live content hash no longer matches — no materialized variant needed.
    const record = makeStemRecord({ "video:timeline#stem": "old-bgm-hash" });

    const changed = collectChangedAddresses([], "video", mgr, TIMELINE_STEM_DEF, record);
    expect(changed).toEqual(["video:timeline#stem"]);
  });

  it("does not flag the timeline stem when its content still matches the baseline", async () => {
    const mgr = await StateManager.init(tmpDir);
    const liveHash = materializedLeafContentHash(
      mgr,
      TIMELINE_STEM_DEF as unknown as VideoDefinition,
      "video:timeline#stem",
    );
    const record = makeStemRecord({ "video:timeline#stem": liveHash! });

    const changed = collectChangedAddresses([], "video", mgr, TIMELINE_STEM_DEF, record);
    expect(changed).toEqual([]);
  });

  it("flags the timeline stem materialized after the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const stemAddr = "video:timeline#stem";
    const vStem = mgr.reserveVariantId(stemAddr);
    setFile(mgr, stemAddr, vStem, "bed.wav");

    // No baseline recorded (a pre-baseline record) — the fresh-materialization fallback catches it.
    const changed = collectChangedAddresses([], "video", mgr, TIMELINE_STEM_DEF, makeStemRecord());
    expect(changed).toEqual(["video:timeline#stem"]);
  });

  it("flags a composition when its content diverges from the review baseline", async () => {
    const mgr = await StateManager.init(tmpDir);
    // No materialized variant, no accept — a reviewed-then-edited composition. The content-hash
    // baseline is the only signal (the fresh-ready / accepted-stale fallbacks would both miss it).
    const shotFn = () => [];
    const def = makeVideoDef(shotFn);
    const compAddr = "video:shot.02#composition";
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: REVIEW_AT,
      context: { shots: [], timeline: {}, contentHashes: { [compAddr]: "old-composition-hash" } },
      decisions: [],
    };

    const changed = collectChangedAddresses(
      [{ id: "02", assets: { motion: {} }, shotFn }],
      "video",
      mgr,
      def,
      record,
    );
    expect(changed).toEqual(["video:shot.02#composition"]);
  });

  it("does not flag a composition whose accepted variant still matches the definition", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.mp4");
    mgr.setAccepted(addr, vOld);

    const shotFn = () => [];
    const def = makeVideoDef(shotFn);

    const compAddr = "video:shot.02#composition";
    const vComp = mgr.reserveVariantId(compAddr);
    setFile(mgr, compAddr, vComp, "composition.html");
    const comp = mgr.ensureAssetState(compAddr).variants?.[vComp];
    if (comp) comp.definitionHash = compositionDefinitionHashForAddress(def, compAddr);
    mgr.setAccepted(compAddr, vComp);

    const changed = collectChangedAddresses(
      [{ id: "02", assets: { motion: {} }, shotFn }],
      "video",
      mgr,
      def,
      makeRecord(vOld),
    );

    expect(changed).toEqual([]);
  });
});

describe("collectAllAddresses", () => {
  // The animatic's shots are compositions too, so a developed one seeds its leaf; an undeveloped
  // shot has none. Its per-shot stem is a real take in the pool, already seeded as an asset.
  it("seeds every shot asset for animatic, plus a composition per developed shot", () => {
    const shots = [
      { id: "01", assets: { key: {}, first: {} }, shotFn: () => [] },
      { id: "02", assets: { key: {} } },
    ];
    expect(collectAllAddresses(shots, "animatic")).toEqual([
      "animatic:shot.01.key",
      "animatic:shot.01.first",
      "animatic:shot.01#composition",
      "animatic:shot.02.key",
    ]);
  });

  it("seeds shot assets plus a composition for each video shot with a shotFn", () => {
    const shots = [
      { id: "01", assets: { motion: {} }, shotFn: () => [] },
      { id: "02", assets: { motion: {} } },
    ];
    expect(collectAllAddresses(shots, "video")).toEqual([
      "video:shot.01.motion",
      "video:shot.01#composition",
      "video:shot.02.motion",
    ]);
  });

  it("seeds a per-shot stem for a shot with audio cues, and the timeline stem for soundtrack beds", () => {
    const shots = [
      { id: "01", assets: { motion: {} }, shotFn: () => [], stemRefs: ["video:shot.01.motion"] },
      { id: "02", assets: { motion: {} }, shotFn: () => [] },
    ];
    expect(collectAllAddresses(shots, "video", {}, [{ id: "bed" }])).toEqual([
      "video:timeline#stem",
      "video:shot.01.motion",
      "video:shot.01#composition",
      "video:shot.01#stem",
      "video:shot.02.motion",
      "video:shot.02#composition",
    ]);
  });

  it("seeds the animatic's plates before its shots", () => {
    const shots = [{ id: "01", assets: { key: {} } }];
    expect(collectAllAddresses(shots, "animatic", {}, [], ["hall-wide"])).toEqual([
      "animatic:plate.hall-wide",
      "animatic:shot.01.key",
    ]);
  });

  it("seeds timeline beds before shots", () => {
    const shots = [{ id: "01", assets: { motion: {} }, shotFn: () => [] }];
    const topLevelAssets = {
      bgm: { deterministic: false },
      sizzle: { deterministic: false },
      logo: { kind: "file" },
    } as unknown as DefinitionLike["topLevelAssets"];
    expect(collectAllAddresses(shots, "video", topLevelAssets)).toEqual([
      "video:timeline.bgm",
      "video:timeline.sizzle",
      "video:timeline.logo",
      "video:shot.01.motion",
      "video:shot.01#composition",
    ]);
  });
});

// A reference def with one generative asset (`hero`) and one file asset (`bg`).
const REFERENCE_DEF = {
  shots: [],
  topLevelAssets: {
    hero: { kind: "fal", deterministic: false, inputs: {} },
    bg: { kind: "file", path: "assets/bg.png" },
  },
  exposedAssetNames: ["hero", "bg"],
} as unknown as ReferenceDefinition;

function makeRefRecord(reviewedHeroId: string): ReviewRecord {
  return {
    mode: "reference-preview",
    stage: "reference",
    createdAt: REVIEW_AT,
    context: { shots: [], timeline: { hero: reviewedHeroId } },
    decisions: [],
  };
}

describe("collectAllReferenceAddresses", () => {
  it("seeds every exposed reference asset", () => {
    expect(collectAllReferenceAddresses(REFERENCE_DEF)).toEqual(["reference:hero", "reference:bg"]);
  });

  // An asset the stage declared without returning it is an intermediate `hero` consumes — read
  // through `hero`, so a handoff has nothing to say about it.
  it("skips an asset the reference stage never returned", () => {
    const withIntermediate = {
      ...REFERENCE_DEF,
      topLevelAssets: {
        ...REFERENCE_DEF.topLevelAssets,
        latent: { kind: "fal", deterministic: false, inputs: {} },
      },
    } as unknown as ReferenceDefinition;
    expect(collectAllReferenceAddresses(withIntermediate)).toEqual([
      "reference:hero",
      "reference:bg",
    ]);
  });
});

describe("collectChangedReferenceAddresses", () => {
  const addr = "reference:hero";

  it("flags a reference asset with a fresh unreviewed ready variant from a reroll", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.png");
    mgr.setAccepted(addr, vOld);
    const vNew = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vNew, "new.png");

    expect(collectChangedReferenceAddresses(REFERENCE_DEF, mgr, makeRefRecord(vOld))).toEqual([
      "reference:hero",
    ]);
  });

  it("reports no changes when the accepted variant still matches the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.png");
    mgr.setAccepted(addr, vOld);

    expect(collectChangedReferenceAddresses(REFERENCE_DEF, mgr, makeRefRecord(vOld))).toEqual([]);
  });

  it("does not flag a leftover ready candidate that became ready before the review", async () => {
    const mgr = await StateManager.init(tmpDir);
    const vOld = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vOld, "old.png", READY_BEFORE);
    mgr.setAccepted(addr, vOld);
    const vLeftover = mgr.reserveVariantId(addr);
    setFile(mgr, addr, vLeftover, "leftover.png", READY_BEFORE);

    expect(collectChangedReferenceAddresses(REFERENCE_DEF, mgr, makeRefRecord(vOld))).toEqual([]);
  });
});

function makeDirection(overrides?: { shot02Action?: string; shot02Duration?: number }): Direction {
  return {
    characters: { cat: { name: "the cat", description: "a brown tabby", promptDepiction: "cat" } },
    sequence: {
      lens: "comedy",
      pleasure: "cute",
      waivers: { "beat-overweight": "deliberate slow open" },
      shots: [
        { id: "01", role: "setup", action: "The cat greets a customer.", duration: 3 },
        {
          id: "02",
          role: "button",
          action: overrides?.shot02Action ?? "The cat naps in a box.",
          duration: overrides?.shot02Duration ?? 2,
        },
      ],
    },
  } as unknown as Direction;
}

// A direction review's baseline is the part-hash snapshot taken at submit.
function makeDirectionRecord(direction: Direction): ReviewRecord {
  return {
    mode: "direction-preview",
    stage: "direction",
    createdAt: REVIEW_AT,
    context: { shots: [], directionParts: Object.fromEntries(directionPartHashes(direction)) },
    decisions: [],
  };
}

describe("collectAllDirectionAddresses", () => {
  it("seeds every direction part in profile-less note form", () => {
    expect(collectAllDirectionAddresses(makeDirection())).toEqual([
      "direction:sequence",
      "direction:brief.outOfScope",
      "direction:brief.tolerances",
      "direction:policy.format",
      "direction:policy.lang",
      "direction:policy.fonts",
      "direction:policy.speech",
      "direction:sequence.waivers.beat-overweight",
      "direction:sequence.shots.01",
      "direction:sequence.shots.02",
      "direction:characters.cat",
    ]);
  });
});

describe("collectChangedDirectionAddresses", () => {
  it("reports no changes when the direction still matches the review baseline", () => {
    const direction = makeDirection();
    expect(collectChangedDirectionAddresses(direction, makeDirectionRecord(direction))).toEqual([]);
  });

  it("flags only the edited shot on a prose change — the sequence hash is structural-only", () => {
    const record = makeDirectionRecord(makeDirection());
    const edited = makeDirection({ shot02Action: "The cat naps in a cardboard box." });
    expect(collectChangedDirectionAddresses(edited, record)).toEqual([
      "direction:sequence.shots.02",
    ]);
  });

  it("flags the sequence part alongside the shot on a structural change", () => {
    const record = makeDirectionRecord(makeDirection());
    const edited = makeDirection({ shot02Duration: 4 });
    expect(collectChangedDirectionAddresses(edited, record)).toEqual([
      "direction:sequence",
      "direction:sequence.shots.02",
    ]);
  });

  it("seeds every part when the record predates the part-hash baseline", () => {
    const direction = makeDirection();
    const record = makeDirectionRecord(direction);
    record.context.directionParts = undefined;
    expect(collectChangedDirectionAddresses(direction, record)).toEqual(
      collectAllDirectionAddresses(direction),
    );
  });
});
