import { describe, expect, it } from "vitest";
import {
  feedbackStaleness,
  generateFeedbackId,
  getFeedbackWithStaleness,
} from "../feedback/index.js";
import { SCHEMA_VERSION } from "../types/index.js";
import type { FeedbackEntry, KonteState, VariantState } from "../types/index.js";

function variant(status: VariantState["status"], extra: Partial<VariantState> = {}): VariantState {
  return {
    status,
    file: "out.png",
    definitionHash: null,
    outputHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    inputFingerprints: {},
    metadata: {},
    ...extra,
  };
}

function makeState(assets: KonteState["assets"]): KonteState {
  return { schemaVersion: SCHEMA_VERSION, assets };
}

function feedback(
  displayedVariants: Record<string, string>,
  displayedDefinitionHashes: Record<string, string> = {},
): FeedbackEntry {
  return {
    id: generateFeedbackId(),
    displayedVariants,
    displayedDefinitionHashes,
    annotation: null,
    text: "note",
    createdAt: "2024-01-01T00:00:00Z",
    createdBy: "local",
  };
}

const MOTION = "video:shot.01.motion";

describe("generateFeedbackId", () => {
  it("returns a fb-<nanoid> format string", () => {
    const id = generateFeedbackId();
    expect(id).toMatch(/^fb-.{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateFeedbackId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });
});

describe("feedbackStaleness", () => {
  it("returns false when the snapshot is empty", () => {
    const state = makeState({
      [MOTION]: { variants: { "v-cur": variant("accepted") } },
    });
    expect(feedbackStaleness(feedback({}), MOTION, state)).toBe("fresh");
  });

  it("returns false when nothing is displayable for the asset", () => {
    const state = makeState({
      [MOTION]: { variants: { "v-x": variant("none", { file: null }) } },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-x" }), MOTION, state)).toBe("fresh");
  });

  it("returns false when the resolved variant still matches the snapshot", () => {
    const state = makeState({
      [MOTION]: { variants: { "v-cur": variant("accepted") } },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-cur" }), MOTION, state)).toBe("fresh");
  });

  it("returns true when a different variant has been accepted", () => {
    const state = makeState({
      [MOTION]: { variants: { "v-cur": variant("accepted") } },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-old" }), MOTION, state)).toBe("stale");
  });

  it("returns true when a reroll surfaces a newer variant, even without acceptance", () => {
    const state = makeState({
      [MOTION]: {
        variants: { "v-1": variant("none"), "v-2": variant("none") },
      },
    });
    // The comment was authored against v-1; the newest ready variant is now v-2.
    expect(feedbackStaleness(feedback({ [MOTION]: "v-1" }), MOTION, state)).toBe("stale");
    // A comment authored against the still-newest variant stays fresh.
    expect(feedbackStaleness(feedback({ [MOTION]: "v-2" }), MOTION, state)).toBe("fresh");
  });

  it("returns true when the accepted variant matches but is now input-stale", () => {
    const state = makeState({
      [MOTION]: {
        variants: {
          "v-cur": variant("accepted", { inputFingerprints: { "video:shot.01.src": "old-hash" } }),
        },
      },
      "video:shot.01.src": {
        variants: { "v-src": variant("accepted", { outputHash: "new-hash" }) },
      },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-cur" }), MOTION, state)).toBe("stale");
  });

  // The review surfaces fall back to the newest stale take rather than blanking, so a comment on
  // one has to answer for what is on screen — the same as the accepted case above.
  it("returns true when the displayed variant is the unaccepted stale fallback", () => {
    const state = makeState({
      [MOTION]: {
        variants: {
          "v-cur": variant("none", { inputFingerprints: { "video:shot.01.src": "old-hash" } }),
        },
      },
      "video:shot.01.src": {
        variants: { "v-src": variant("none", { outputHash: "new-hash" }) },
      },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-cur" }), MOTION, state)).toBe("stale");
  });

  it("goes stale if any one asset in a multi-asset snapshot changed", () => {
    const BG = "video:shot.01.bg";
    const state = makeState({
      [MOTION]: { variants: { "v-m1": variant("accepted") } },
      [BG]: { variants: { "v-b2": variant("accepted") } },
    });
    expect(feedbackStaleness(feedback({ [MOTION]: "v-m1", [BG]: "v-b2" }), MOTION, state)).toBe(
      "fresh",
    );
    expect(feedbackStaleness(feedback({ [MOTION]: "v-m1", [BG]: "v-b1" }), MOTION, state)).toBe(
      "stale",
    );
  });

  // Composite-frame feedback attaches to the bare shot target but snapshots the
  // composition variant it was about. Staleness reads the snapshot, not the attach
  // target, so it auto-resolves whether the fix re-renders the composition via a
  // shotFn edit or an upstream clip reroll — both produce a new composition variant.
  it("auto-resolves shot-target feedback when the snapshotted composition re-renders", () => {
    const COMPOSITION = "video:shot.01#composition";
    const state = makeState({
      [COMPOSITION]: { variants: { "v-comp2": variant("accepted") } },
    });
    expect(feedbackStaleness(feedback({ [COMPOSITION]: "v-comp2" }), COMPOSITION, state)).toBe(
      "fresh",
    );
    expect(feedbackStaleness(feedback({ [COMPOSITION]: "v-comp1" }), COMPOSITION, state)).toBe(
      "stale",
    );
  });
});

// A review has no "reject": a target needing work is one left unaccepted. So an accept landing on a
// comment is the verdict "going with this" — the comment stops standing, exactly as it would if the
// take had moved under it — and only a comment written after it still asks for work.
describe("feedbackStaleness (an accept stamped over the comment)", () => {
  const COMMENTED_AT = "2026-01-01T00:00:00.000Z";

  function note(): FeedbackEntry {
    return { ...feedback({ [MOTION]: "v-cur" }), createdAt: COMMENTED_AT };
  }

  it("settles a comment the target was accepted over", () => {
    const state = makeState({
      [MOTION]: {
        variants: { "v-cur": variant("accepted", { decidedAt: "2026-01-02T00:00:00.000Z" }) },
      },
    });
    expect(feedbackStaleness(note(), MOTION, state)).toBe("stale");
  });

  it("leaves a comment written after that accept standing", () => {
    const state = makeState({
      [MOTION]: {
        variants: { "v-cur": variant("accepted", { decidedAt: "2025-12-31T00:00:00.000Z" }) },
      },
    });
    expect(feedbackStaleness(note(), MOTION, state)).toBe("fresh");
  });

  it("says nothing with no accept, or one stamped before decidedAt was recorded", () => {
    expect(feedbackStaleness(note(), MOTION, makeState({}))).toBe("fresh");
    expect(
      feedbackStaleness(
        note(),
        MOTION,
        makeState({ [MOTION]: { variants: { "v-cur": variant("accepted") } } }),
      ),
    ).toBe("fresh");
  });

  it("compares the two instants, not their spellings", () => {
    // `…:00Z` sorts after `…:00.500Z` lexically; the accept here is half a second EARLIER than the
    // comment, so nothing was signed off.
    const state = makeState({
      [MOTION]: {
        variants: { "v-cur": variant("accepted", { decidedAt: "2025-12-31T23:59:59Z" }) },
      },
    });
    const written = { ...note(), createdAt: "2025-12-31T23:59:59.500Z" };
    expect(feedbackStaleness(written, MOTION, state)).toBe("fresh");
  });

  // A whole-shot target holds comments but no variant of its own; the shot's one "ok" lands on its
  // materialized leaves, so that is what signs its comments off.
  it("settles a whole-shot comment through the shot's composition accept", () => {
    const state = makeState({
      "video:shot.01#composition": {
        variants: { "v-comp": variant("accepted", { decidedAt: "2026-01-02T00:00:00.000Z" }) },
      },
    });
    expect(feedbackStaleness(note(), "video:shot.01", state)).toBe("stale");
    expect(feedbackStaleness(note(), "video:shot.02", state)).toBe("fresh");
  });

  // Nothing says which half a shot comment is about — konte cannot read whether "the mother sounds
  // too crisp" is about the picture or the sound — so a shot that sounds something is answered only
  // once both halves are signed off. The picture accept alone used to close it, dropping a note on a
  // line nobody had re-heard.
  it("holds a whole-shot comment open until the shot's stem is signed off too", () => {
    const STEM = "video:shot.01#stem";
    const heard = { ...note(), displayedDefinitionHashes: { [STEM]: "s1" } };
    // Supplied so the leaf axis reads fresh rather than unknown — this is about the accept axis.
    const ctx = { definitionHashes: new Map([[STEM, "s1"]]) };
    const accepted = (decidedAt: string) => ({
      variants: { [`v-${decidedAt}`]: variant("accepted", { decidedAt }) },
    });

    const pictureOnly = makeState({
      "video:shot.01#composition": accepted("2026-01-02T00:00:00.000Z"),
    });
    expect(feedbackStaleness(heard, "video:shot.01", pictureOnly, ctx)).toBe("fresh");

    const bothHalves = makeState({
      "video:shot.01#composition": accepted("2026-01-02T00:00:00.000Z"),
      [STEM]: accepted("2026-01-02T00:00:01.000Z"),
    });
    expect(feedbackStaleness(heard, "video:shot.01", bothHalves, ctx)).toBe("stale");
  });

  // The stem is only half of it either: a shot whose picture carries no sign-off is unfinished
  // whatever its audio says.
  it("does not settle a whole-shot comment through the shot's audio stem alone", () => {
    const state = makeState({
      "video:shot.01#stem": {
        variants: { "v-stem": variant("accepted", { decidedAt: "2026-01-02T00:00:00.000Z" }) },
      },
    });
    expect(feedbackStaleness(note(), "video:shot.01", state)).toBe("fresh");
  });

  // The direction is variant-less: its sign-off is the per-part acceptance record.
  it("settles a direction comment through that part's acceptance", () => {
    const address = "direction:brief.logline";
    const state = {
      ...makeState({}),
      directionAcceptance: {
        parts: { [address]: { partHash: "h", acceptedAt: "2026-01-02T00:00:00.000Z" } },
        whole: { hash: "c", acceptedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    expect(feedbackStaleness(note(), address, state)).toBe("stale");
    expect(feedbackStaleness(note(), "direction:brief.tone", state)).toBe("fresh");
  });
});

describe("getFeedbackWithStaleness", () => {
  it("computes the stale flag for each entry", () => {
    const state = makeState({
      [MOTION]: { variants: { "v-cur": variant("accepted") } },
    });
    const result = getFeedbackWithStaleness(
      [feedback({ [MOTION]: "v-cur" }), feedback({ [MOTION]: "v-old" }), feedback({})],
      MOTION,
      state,
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.staleness).toBe("fresh");
    expect(result[1]!.staleness).toBe("stale");
    expect(result[2]!.staleness).toBe("fresh");
  });
});

const COMPOSITION = "video:shot.01#composition";
const AUDIO = "video:shot.01.audio";

describe("composition feedback staleness", () => {
  // A composition renders live and only gains a variant when accepted, so a shotFn edit (a
  // transition) that mints no variant is caught by the snapshotted live definition hash instead.
  it("stays live while the composition definition hash is unchanged, even unaccepted", () => {
    const state = makeState({});
    const defHashes = new Map([[COMPOSITION, "d1"]]);
    expect(
      feedbackStaleness(feedback({}, { [COMPOSITION]: "d1" }), COMPOSITION, state, {
        definitionHashes: defHashes,
      }),
    ).toBe("fresh");
  });

  it("goes stale on a shotFn edit that changes the definition hash without minting a variant", () => {
    const state = makeState({});
    const defHashes = new Map([[COMPOSITION, "d2"]]);
    expect(
      feedbackStaleness(feedback({}, { [COMPOSITION]: "d1" }), COMPOSITION, state, {
        definitionHashes: defHashes,
      }),
    ).toBe("stale");
  });

  it("reads unknown, not fresh, when no definition-hash context is given", () => {
    const state = makeState({});
    // A reader that cannot load the video has not checked this axis. Saying "fresh" there is what
    // let a comment read as still standing however far its leaf had moved.
    expect(feedbackStaleness(feedback({}, { [COMPOSITION]: "d1" }), COMPOSITION, state)).toBe(
      "unknown",
    );
  });

  // "stale" is a verdict and "unknown" is the absence of one, so a moved take settles the comment
  // however unreadable another axis is.
  it("lets a moved take outrank an unreadable leaf", () => {
    const state = makeState({ [MOTION]: { variants: { "v-new": variant("accepted") } } });
    const entry = {
      ...feedback({ [MOTION]: "v-old" }),
      displayedDefinitionHashes: { [COMPOSITION]: null },
    };
    expect(feedbackStaleness(entry, COMPOSITION, state, { definitionHashes: new Map() })).toBe(
      "stale",
    );
  });

  it("reads a null leaf hash as unknown when every other axis agrees", () => {
    const state = makeState({ [MOTION]: { variants: { "v-cur": variant("accepted") } } });
    const entry = {
      ...feedback({ [MOTION]: "v-cur" }),
      displayedDefinitionHashes: { [COMPOSITION]: null },
    };
    expect(feedbackStaleness(entry, COMPOSITION, state, { definitionHashes: new Map() })).toBe(
      "unknown",
    );
  });

  it("goes stale when a provided context no longer holds the leaf (shotFn removed)", () => {
    const state = makeState({});
    // Context present but this composition is gone from the definition — like a vanished direction part.
    expect(
      feedbackStaleness(feedback({}, { [COMPOSITION]: "d1" }), COMPOSITION, state, {
        definitionHashes: new Map(),
      }),
    ).toBe("stale");
  });

  it("goes stale once a new composition variant is accepted after a shotFn fix (UC3)", () => {
    // The shotFn was edited and re-signed-off: v-b is now accepted, superseding v-a.
    const state = makeState({
      [COMPOSITION]: {
        variants: {
          "v-a": variant("none", { file: "composition.html" }),
          "v-b": variant("accepted", { file: "composition.html" }),
        },
      },
    });
    expect(feedbackStaleness(feedback({ [COMPOSITION]: "v-a" }), COMPOSITION, state)).toBe("stale");
  });

  it("goes stale when an upstream asset of the accepted composition changes (UC1)", () => {
    const state = makeState({
      [AUDIO]: {
        variants: { "v-audio": variant("accepted", { file: "a.mp3", outputHash: "audio-2" }) },
      },
      [COMPOSITION]: {
        variants: {
          "v-a": variant("accepted", {
            file: "composition.html",
            inputFingerprints: { "video:shot.01.audio": "audio-1" },
          }),
        },
      },
    });
    expect(feedbackStaleness(feedback({ [COMPOSITION]: "v-a" }), COMPOSITION, state)).toBe("stale");
  });
});

const SHOT_PART = "direction:sequence.shots.01";

describe("direction feedback staleness", () => {
  const state = makeState({});
  const note = (subjectHash: string): FeedbackEntry => ({ ...feedback({}), subjectHash });

  it("stays live while the part it was written against is unchanged", () => {
    const hashes = new Map([[SHOT_PART, "h1"]]);
    expect(feedbackStaleness(note("h1"), SHOT_PART, state, { subjectHashes: hashes })).toBe(
      "fresh",
    );
  });

  it("goes stale once the part changed", () => {
    const hashes = new Map([[SHOT_PART, "h2"]]);
    expect(feedbackStaleness(note("h1"), SHOT_PART, state, { subjectHashes: hashes })).toBe(
      "stale",
    );
  });

  it("goes stale once the part is gone from the direction", () => {
    expect(feedbackStaleness(note("h1"), SHOT_PART, state, { subjectHashes: new Map() })).toBe(
      "stale",
    );
  });

  it("reads unknown, not fresh, when the direction could not be loaded", () => {
    expect(feedbackStaleness(note("h1"), SHOT_PART, state)).toBe("unknown");
  });
});
