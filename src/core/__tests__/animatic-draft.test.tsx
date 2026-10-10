import { describe, expect, it } from "vitest";
import {
  formatDraftAssetPath,
  formatDraftPreviousAssetPath,
  isDraftAddress,
  isDraftTakeAddress,
  listAssetPaths,
  listReviewableAssetPaths,
  matchesAddressScope,
  parseAddress,
  assertValidAddressScope,
} from "../address.js";
import { readDraftCuts } from "../draft-cuts.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  Composition,
  Panel,
  adapters,
  asset,
  defineAnimatic,
  defineDirection,
  type MediaAsset,
} from "../dsl/index.js";
import {
  buildDependencyGraph,
  collectRerollCascade,
  listSetupAnchorGaps,
  listPlateDescriptionUses,
  listUnusedAssetPaths,
} from "../graph.js";
import { computeVariantStaleness, selectResolvedVariant } from "../staleness.js";
import { isTurboTake } from "../turbo.js";
import type { KonteState, VariantState } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";
import { moves } from "./helpers/shot.js";

const draftComfy = defineComfyAsset({
  workflow: "draft.json",
  description: "test multi-shot adapter",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt", required: true },
    image1: { nodeId: "2", field: "image", type: "image" },
    video1: { nodeId: "3", field: "file", type: "video" },
    width: { nodeId: "4", field: "width", type: "width", default: 1344 },
    height: { nodeId: "4", field: "height", type: "height", default: 768 },
    length: { nodeId: "4", field: "length", type: "frames", clock: 24, default: 120, max: 240 },
    useTurbo: { nodeId: "5", field: "value", type: "boolean", default: false },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
  turbo: { useTurbo: true },
});

const shotOnly = defineComfyAsset({
  workflow: "shot-only.json",
  description: "test adapter a draft may not use",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt", required: true } },
  outputs: { result: { nodeId: "9", type: "video" } },
  allowedIn: ["shot"],
});

const panelComfy = defineComfyAsset({
  workflow: "panel.json",
  description: "test panel adapter",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt", required: true },
    image1: { nodeId: "2", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// 01 02 [aside] 03 in the studio, 04 on the roof.
const direction = defineDirection({
  ...directionDefaults,
  locations: {
    ...directionDefaults.locations,
    roof: {
      name: "the roof",
      description: "a flat roof",
      landmarks: {
        tank: { name: "the tank", promptDepiction: "water tank", description: "a steel tank" },
      },
    },
  },
  setups: {
    front: {
      name: "the front angle",
      description: "straight on, eye level",
      location: "studio",
      framing: "medium",
      holds: ["desk"],
    },
    roofWide: {
      name: "the roof, wide",
      description: "from the stair door",
      location: "roof",
      framing: "wide",
      holds: ["tank"],
    },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "she sits", setup: "front", duration: 2, lineup: [] },
      { id: "02", role: "ordinary", action: "she stands", setup: "front", duration: 3, lineup: [] },
      { kind: "aside", id: "ec", label: "eyecatch", duration: 1 },
      { id: "03", role: "ordinary", action: "she leaves", setup: "front", duration: 4, lineup: [] },
      {
        id: "04",
        role: "ordinary",
        action: "the roof",
        setup: "roofWide",
        duration: 2,
        lineup: [],
      },
    ],
  },
});

const TEXT: Record<string, string> = { "01": "one", "02": "two", "03": "three", "04": "four" };

type Starter = Parameters<
  NonNullable<Parameters<typeof defineAnimatic<typeof direction>>[1]["drafts"]>
>[0];

const board = (drafts: (args: Starter) => Record<string, unknown>) =>
  defineAnimatic(direction, {
    drafts: drafts as never,
    timeline: ({ pendingShot }) => ({
      shots: pendingShot("01")
        .nextPendingShot("02")
        .nextAsideShot("ec")
        .nextPendingShot("03")
        .nextPendingShot("04"),
    }),
  });

const take = (name: string, extra: Record<string, unknown> = {}) =>
  asset(name as "take", draftComfy, { prompt: "the take", ...extra });

describe("animatic:draft addresses", () => {
  it("parses a draft take and the cut of the take before it", () => {
    expect(parseAddress("animatic:draft.opening")).toEqual({
      stage: "animatic",
      kind: "draft",
      assetName: "opening",
      delivery: false,
    });
    expect(formatDraftAssetPath("opening")).toBe("animatic:draft.opening");
    expect(formatDraftPreviousAssetPath("opening")).toBe("animatic:draft.opening#previous");
    expect(isDraftTakeAddress("animatic:draft.opening")).toBe(true);
    expect(isDraftTakeAddress("animatic:draft.opening#previous")).toBe(false);
    expect(isDraftAddress("animatic:draft.opening#previous")).toBe(true);
    expect(isDraftAddress("animatic:shot.01.draft")).toBe(false);
  });

  it("is an address-scope of the animatic alone", () => {
    expect(() => assertValidAddressScope("animatic:draft")).not.toThrow();
    expect(() => assertValidAddressScope("animatic:draft.opening")).not.toThrow();
    expect(() => assertValidAddressScope("video:draft")).toThrow();
    expect(() => parseAddress("video:draft.opening")).toThrow();
    expect(() => parseAddress("animatic:draft.opening#delivery")).toThrow();
    expect(matchesAddressScope("animatic:draft.opening#previous", "animatic:draft.opening")).toBe(
      true,
    );
  });
});

describe("defineAnimatic drafts", () => {
  it("files a take at animatic:draft.<name> on the derived size, length and cut times", () => {
    let cut: unknown;
    const animatic = board(({ draft }) => ({
      opening: draft(["01", "02"], ({ cuts, duration }) => {
        cut = { cuts: cuts((id) => TEXT[id]!), duration };
        return take("opening");
      }),
    }));
    expect(cut).toEqual({ cuts: ["one", { at: 2, text: "two" }], duration: 5 });
    expect(animatic.draftShots).toEqual({ opening: ["01", "02"] });
    const def = animatic.drafts!.opening as { inputs: Record<string, unknown> };
    // 0.15 MP at the delivery's 16:9, and 5s on the adapter's 24fps clock.
    expect(def.inputs["4.width"]).toBe(512);
    expect(def.inputs["4.height"]).toBe(288);
    expect(def.inputs["4.length"]).toBe(120);
    expect(listAssetPaths(animatic, "animatic")).toContain("animatic:draft.opening");
    expect(listReviewableAssetPaths(animatic, "animatic")).not.toContain("animatic:draft.opening");
  });

  it("hands a take the tail of the one before it, across an aside, cut to its own length", () => {
    const seen: Record<string, MediaAsset<"video"> | undefined> = {};
    const animatic = board(({ draft }) => ({
      // Declared out of order: the builds run in direction order.
      later: draft(["03"], ({ previous }) => {
        seen.later = previous;
        return take("later", { video1: previous });
      }),
      opening: draft(["01", "02"], ({ previous }) => {
        seen.opening = previous;
        return take("opening");
      }),
    }));
    expect(seen.opening).toBeUndefined();
    expect(seen.later?.src).toBe("__konte:animatic:draft.later#previous__");
    expect(animatic.drafts!["later#previous"]).toMatchObject({
      kind: "local",
      operation: "trim",
      inputs: { source: "__konte:animatic:draft.opening__", start: "tail", duration: 4 },
    });
    const graph = buildDependencyGraph(null, animatic, null);
    expect(graph.dependencies.get("animatic:draft.later")).toEqual([
      "animatic:draft.later#previous",
    ]);
    expect(graph.dependencies.get("animatic:draft.later#previous")).toEqual([
      "animatic:draft.opening",
    ]);
  });

  it("hands over nothing where the place changes, and declares no cut nobody takes", () => {
    let previous: MediaAsset<"video"> | undefined | null = null;
    const animatic = board(({ draft }) => ({
      studio: draft(["03"], () => take("studio")),
      roof: draft(["04"], (ctx) => {
        previous = ctx.previous;
        return take("roof");
      }),
    }));
    expect(previous).toBeUndefined();
    expect(Object.keys(animatic.drafts!)).toEqual(["studio", "roof"]);
  });

  it("rejects a run that is not consecutive in direction order", () => {
    expect(() =>
      board(({ draft }) => ({ a: draft(["01", "03"] as never, () => take("a")) })),
    ).toThrow(/not a run of consecutive shots/);
    expect(() =>
      board(({ draft }) => ({ a: draft(["02", "01"] as never, () => take("a")) })),
    ).toThrow(/not a run of consecutive shots/);
  });

  it("rejects an aside in the run", () => {
    expect(() =>
      board(({ draft }) => ({ a: draft(["02", "ec"] as never, () => take("a")) })),
    ).toThrow(/an aside/);
  });

  it("rejects a shot in two drafts", () => {
    expect(() =>
      board(({ draft }) => ({
        a: draft(["01", "02"], () => take("a")),
        b: draft(["02"], () => take("b")),
      })),
    ).toThrow(/is in two drafts/);
  });

  it("rejects a draft returned under another name than its take's", () => {
    expect(() => board(({ draft }) => ({ a: draft(["01"], () => take("b")) }))).toThrow(
      /must return the take its build declares as asset\("a"/,
    );
  });

  it("rejects a take no reroll could replace", () => {
    expect(() =>
      board(({ draft }) => ({
        a: draft(["01"], () =>
          asset("a", adapters.videoTrim, {
            source: { src: "__konte:reference:footage__" } as MediaAsset<"video">,
            start: 0,
            duration: 2,
          }),
        ),
      })),
    ).toThrow(/is a deterministic asset/);
  });

  it("rejects a helper declared beside the takes", () => {
    expect(() =>
      board(({ draft }) => {
        take("helper");
        return { a: draft(["01"], () => take("a")) };
      }),
    ).toThrow(/`drafts` declares takes only/);
  });

  it("rejects a run longer than the adapter's frame ceiling", () => {
    // 2 + 3 + 4 would be consecutive without the aside; 03 + 04 is 6s = 144 frames under 240, so
    // the ceiling is reached by lowering it instead.
    const short = defineComfyAsset({
      workflow: "short.json",
      description: "test adapter",
      inputs: {
        prompt: { nodeId: "1", field: "text", type: "prompt", required: true },
        length: { nodeId: "4", field: "length", type: "frames", clock: 24, default: 24, max: 100 },
      },
      outputs: { result: { nodeId: "9", type: "video" } },
    });
    expect(() =>
      board(({ draft }) => ({
        a: draft(["01", "02"], () => asset("a", short, { prompt: "x" })),
      })),
    ).toThrow(/past this adapter's maximum of 100.*Split the draft's shots across two takes/s);
  });

  it("rejects an adapter that does not allow the draft site", () => {
    expect(() =>
      board(({ draft }) => ({ a: draft(["01"], () => asset("a", shotOnly, { prompt: "x" })) })),
    ).toThrow(/may only be declared in shot/);
  });
});

const drawn = (frames: { id: "01" | "02"; at: number; in?: string }) =>
  defineAnimatic(direction, {
    plates: () => ({
      front: {
        image: asset("front", panelComfy, { prompt: "the empty studio" }),
        prompt: "a plain studio, the desk at the right edge",
      },
    }),
    drafts: ({ draft, plates }) => ({
      opening: draft(["01", "02"], () =>
        asset("opening", draftComfy, {
          prompt: `two shots in ${plates.front!.prompt}`,
          image1: plates.front!.image,
        }),
      ),
    }),
    timeline: ({ shot, drafts }) => ({
      shots: shot("01", () => {
        const frame = drafts.opening.frame(frames.id as "01", "draftFirst", { at: frames.at });
        const first = asset("first", panelComfy, { prompt: "she sits", image1: frame });
        return (
          <Composition>
            <Panel src={first} {...moves} />
          </Composition>
        );
      })
        .nextPendingShot("02")
        .nextAsideShot("ec")
        .nextPendingShot("03")
        .nextPendingShot("04"),
    }),
  });

describe("drafts.<name>.frame", () => {
  it("declares the shot's own videoFrame of the take", () => {
    const animatic = drawn({ id: "01", at: 0.5 });
    expect(animatic.shots[0]!.assets.draftFirst).toMatchObject({
      kind: "local",
      operation: "frame",
      deterministic: true,
      inputs: { source: "__konte:animatic:draft.opening__", at: 0.5 },
    });
  });

  it("rejects a time outside the take", () => {
    expect(() => drawn({ id: "01", at: 5 })).toThrow(/is outside animatic:draft.opening/);
    expect(() => drawn({ id: "01", at: -1 })).toThrow(/is outside animatic:draft.opening/);
  });

  it("rejects a frame declared in another shot's build", () => {
    expect(() => drawn({ id: "02", at: 2.5 })).toThrow(/is called inside that shot's build/);
  });

  it("refuses at the type level an id the draft does not cover", () => {
    defineAnimatic(direction, {
      drafts: ({ draft }) => ({ opening: draft(["01", "02"], () => take("opening")) }),
      timeline: ({ pendingShot, drafts }) => {
        // @ts-expect-error "03" is not in the draft's run
        const reach = () => drafts.opening.frame("03", "x", { at: 0 });
        void reach;
        return {
          shots: pendingShot("01")
            .nextPendingShot("02")
            .nextAsideShot("ec")
            .nextPendingShot("03")
            .nextPendingShot("04"),
        };
      },
    });
  });
});

describe("a draft on the graph", () => {
  it("is generated while every shot on it is still pending", () => {
    const animatic = board(({ draft }) => ({
      opening: draft(["01", "02"], () => take("opening")),
    }));
    const graph = buildDependencyGraph(null, animatic, null);
    expect(listUnusedAssetPaths(null, animatic, graph)).toEqual([]);
  });

  it("carries a panel drawn from its frame back to the plate it was handed", () => {
    const animatic = drawn({ id: "01", at: 0.5 });
    const frames = [{ shotId: "01", lane: "main" as const, setup: "front" }];
    const gaps = listSetupAnchorGaps(animatic, frames, new Map([["front", "studio"]]));
    expect(gaps.unanchoredShots.size).toBe(0);
    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: true },
    ]);
  });

  it("cascades a reroll into nothing, and stops one that reaches it", () => {
    const animatic = drawn({ id: "01", at: 0.5 });
    const graph = buildDependencyGraph(null, animatic, null);
    expect(collectRerollCascade(graph, "animatic:draft.opening", animatic, () => false)).toEqual(
      [],
    );
    expect(collectRerollCascade(graph, "animatic:plate.front", animatic, () => false)).toEqual([]);
  });
});

const variant = (over: Partial<VariantState>): VariantState => ({
  status: "none",
  file: "x.mp4",
  definitionHash: "then",
  outputHash: "out",
  createdAt: "2026-01-01T00:00:00.000Z",
  readyAt: "2026-01-01T00:00:00.000Z",
  decidedAt: null,
  inputFingerprints: {},
  seed: null,
  derivedFrom: null,
  patchHash: null,
  metadata: {},
  ...over,
});

describe("a draft take in state", () => {
  const address = "animatic:draft.opening";
  const state = {
    assets: {
      "animatic:plate.front": { variants: { "v-p2": variant({ outputHash: "plate-now" }) } },
      [address]: {
        variants: {
          "v-old": variant({ inputFingerprints: { "animatic:plate.front": "plate-then" } }),
          "v-new": variant({
            createdAt: "2026-01-02T00:00:00.000Z",
            inputFingerprints: { "animatic:plate.front": "plate-then" },
          }),
        },
      },
    },
  } as unknown as KonteState;

  it("is never stale, on either axis", () => {
    const take = state.assets[address]!.variants!["v-new"]!;
    expect(computeVariantStaleness(state, address, take, "now")).toMatchObject({
      inputStale: false,
      definitionStale: false,
    });
  });

  it("resolves to its newest take for a spend", () => {
    expect(selectResolvedVariant(state, address)).toEqual({
      variantId: "v-new",
      isAccepted: false,
    });
  });

  it("leaves the cut of the take before it an ordinary asset, stale on either axis", () => {
    const cut = variant({ inputFingerprints: { [address]: "an-older-take" } });
    expect(computeVariantStaleness(state, `${address}#previous`, cut, "now")).toMatchObject({
      inputStale: true,
      definitionStale: true,
    });
  });

  it("is never generated on turbo", () => {
    const animatic = board(({ draft }) => ({
      opening: draft(["01", "02"], () => take("opening")),
    }));
    const def = animatic.drafts!.opening!;
    expect((def as { turboInputs?: unknown }).turboInputs).toBeDefined();
    expect(isTurboTake(address, def, undefined)).toBe(false);
  });
});

describe("readDraftCuts", () => {
  const shots = [
    { id: "01", duration: 4.5 },
    { id: "02", duration: 2 },
    { id: "03", duration: 2 },
  ];

  it("reads each cut off the nearest detection, either side of the stated time", () => {
    expect(readDraftCuts(shots, [4.25, 6.75])).toEqual({
      cuts: [
        { shotId: "01", expected: 0, detected: null },
        { shotId: "02", expected: 4.5, detected: 4.25 },
        { shotId: "03", expected: 6.5, detected: 6.75 },
      ],
      unmatched: [],
    });
  });

  it("leaves a cut unread where nothing falls near it, and lists what a move set off", () => {
    expect(readDraftCuts(shots, [1.2, 1.4, 4.6])).toEqual({
      cuts: [
        { shotId: "01", expected: 0, detected: null },
        { shotId: "02", expected: 4.5, detected: 4.6 },
        { shotId: "03", expected: 6.5, detected: null },
      ],
      unmatched: [1.2, 1.4],
    });
  });
});
