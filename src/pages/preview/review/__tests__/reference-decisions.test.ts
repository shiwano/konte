import { describe, expect, it } from "vitest";
import type { ReferenceAssetInfo } from "../../types.js";
import {
  reacceptIsMeaningful,
  referenceDecisionFor,
  referenceEffectiveStatus,
  referenceBulkAccept,
  referenceUndecidedAssets,
} from "../reference-decisions.js";

const asset = (o: Partial<ReferenceAssetInfo> = {}): ReferenceAssetInfo => ({
  assetName: "paperBag",
  address: "reference:paperBag",
  variantId: "v-1",
  variantStatus: "accepted",
  mediaKind: "image",
  imageUrl: null,
  variants: [],
  feedback: [],
  ...o,
});

const roster = (needsReview: boolean): ReferenceAssetInfo["directionRoster"] => [
  {
    kind: "prop",
    name: "持ち帰りの紙袋",
    description: "平たい持ち手の付いた茶色の紙袋。",
    needsReview,
  },
];

describe("referenceDecisionFor", () => {
  // The loop the roster cascade exists to close: the image is untouched and already accepted, only
  // the direction prose was reworded. Keying the decision on the variant alone drops it here, and
  // the submit then cascades nothing — the reviewer presses Accept and the gate stays shut.
  it("sends a re-accept of the same variant when the roster entry's prose is stale", () => {
    const a = asset({ directionRoster: roster(true) });
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "accepted" })).toEqual({
      address: "reference:paperBag",
      variantId: "v-1",
      status: "accepted",
      candidateVariantIds: [],
    });
  });

  it("sends nothing for a re-accept that settles nothing", () => {
    const a = asset({ directionRoster: roster(false) });
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "accepted" })).toBeNull();
  });

  it("sends a re-accept when a fresh take waits beside the accepted one", () => {
    const a = asset({
      variants: [{ variantId: "v-2", isNew: true }] as ReferenceAssetInfo["variants"],
    });
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "accepted" })?.status).toBe(
      "accepted",
    );
  });

  it("sends an accept that moves to a different variant, naming the takes it was made among", () => {
    const a = asset({
      variants: [{ variantId: "v-1" }, { variantId: "v-2" }] as ReferenceAssetInfo["variants"],
    });
    expect(referenceDecisionFor(a, { variantId: "v-2", status: "accepted" })).toEqual({
      address: "reference:paperBag",
      variantId: "v-2",
      status: "accepted",
      candidateVariantIds: ["v-1", "v-2"],
    });
  });

  it("sends an un-accept only for the variant actually accepted", () => {
    const a = asset();
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "none" })?.status).toBe("none");
    expect(referenceDecisionFor(a, { variantId: "v-2", status: "none" })).toBeNull();
  });

  it("treats an asset with no accepted variant as accepting fresh", () => {
    const a = asset({ variantStatus: "none" });
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "accepted" })?.status).toBe(
      "accepted",
    );
    expect(referenceDecisionFor(a, { variantId: "v-1", status: "none" })).toBeNull();
  });

  // A plain reference asset (a BGM bed) anchors no roster entry, so it has no prose to go stale.
  it("is unaffected by a missing roster entry", () => {
    expect(reacceptIsMeaningful(asset())).toBe(false);
  });
});

describe("referenceEffectiveStatus", () => {
  it("reads the persisted accept only for the variant on screen", () => {
    const a = asset();
    expect(referenceEffectiveStatus(a, "v-1", undefined)).toBe("accepted");
    expect(referenceEffectiveStatus(a, "v-2", undefined)).toBe("none");
  });

  it("lets an override win on the variant it was set on, and only that one", () => {
    const a = asset();
    expect(referenceEffectiveStatus(a, "v-2", { variantId: "v-2", status: "accepted" })).toBe(
      "accepted",
    );
    expect(referenceEffectiveStatus(a, "v-3", { variantId: "v-2", status: "accepted" })).toBe(
      "none",
    );
    expect(referenceEffectiveStatus(a, "v-1", { variantId: "v-1", status: "none" })).toBe("none");
  });

  // The re-accept cases stay undecided until pressed, so the row keeps prompting "Accept".
  it("reads none while a re-accept would still settle something", () => {
    const fresh = asset({
      variants: [{ variantId: "v-2", isNew: true }] as ReferenceAssetInfo["variants"],
    });
    expect(referenceEffectiveStatus(fresh, "v-1", undefined)).toBe("none");
    expect(
      referenceEffectiveStatus(asset({ directionRoster: roster(true) }), "v-1", undefined),
    ).toBe("none");
  });
});

describe("referenceUndecidedAssets", () => {
  // The take on screen is not the accepted one, and nothing was said about it: exactly the blank
  // the confirmation exists to name.
  it("names an asset shown at a variant nobody accepted or commented on", () => {
    const a = asset({ variants: [{ variantId: "v-2" }] as ReferenceAssetInfo["variants"] });
    expect(referenceUndecidedAssets([a], { "reference:paperBag": "v-2" }, {}, new Set())).toEqual([
      "paperBag",
    ]);
  });

  // The regression: picking an older (now definition-stale) take from the gallery and accepting it
  // leaves the row "Needs review" — the take is still stale — so keying the confirmation on that
  // named a row whose own button reads "Accepted".
  it("says nothing about a stale variant picked from the gallery and accepted", () => {
    const a = asset({
      variantStatus: "none",
      variants: [
        { variantId: "v-1", stale: true },
        { variantId: "v-2", stale: false },
      ] as ReferenceAssetInfo["variants"],
    });
    const undecided = referenceUndecidedAssets(
      [a],
      { "reference:paperBag": "v-1" },
      { "reference:paperBag": { variantId: "v-1", status: "accepted" } },
      new Set(),
    );
    expect(undecided).toEqual([]);
  });

  // A comment IS the reason the confirmation asks for, and an explicit un-accept without one is not.
  it("skips a commented asset but keeps an un-accept that says nothing", () => {
    const a = asset();
    expect(
      referenceUndecidedAssets(
        [a],
        {},
        { "reference:paperBag": { variantId: "v-1", status: "none" } },
        new Set(["reference:paperBag"]),
      ),
    ).toEqual([]);
    expect(
      referenceUndecidedAssets(
        [a],
        {},
        { "reference:paperBag": { variantId: "v-1", status: "none" } },
        new Set(),
      ),
    ).toEqual(["paperBag"]);
  });

  // An asset with no readable variant has nothing on screen to decide about.
  it("leaves out assets that take no accept at all", () => {
    const noVariant = asset({ variantId: null, variantStatus: "none" });
    expect(referenceUndecidedAssets([noVariant], {}, {}, new Set())).toEqual([]);
  });
});

describe("referenceBulkAccept", () => {
  it("counts an asset shown at a variant nobody accepted", () => {
    const a = asset({ variants: [{ variantId: "v-2" }] as ReferenceAssetInfo["variants"] });
    expect([...referenceBulkAccept([a], { "reference:paperBag": "v-2" }, {}).unaccepted]).toEqual([
      "reference:paperBag",
    ]);
  });

  // The deadlock this set exists to break: an accepted take whose input moved is stale forever
  // until `konte reroll` replaces it. Counting it left Accept all stuck on "Accept all" over a
  // page where pressing it produced no decision, and Submit disabled with nothing to reach.
  it("leaves out an accepted take that has only gone stale", () => {
    const a = asset({
      variants: [{ variantId: "v-1", stale: true }] as ReferenceAssetInfo["variants"],
    });
    expect(referenceBulkAccept([a], {}, {}).unaccepted.size).toBe(0);
    expect(
      referenceBulkAccept(
        [a],
        {},
        {
          "reference:paperBag": { variantId: "v-1", status: "accepted" },
        },
      ).unaccepted.size,
    ).toBe(0);
  });

  it("counts a stale accept a fresh take waits beside, which an accept does settle", () => {
    const a = asset({
      variants: [
        { variantId: "v-1", stale: true, isNew: false },
        { variantId: "v-2", stale: false, isNew: true },
      ] as ReferenceAssetInfo["variants"],
    });
    expect(referenceBulkAccept([a], {}, {}).unaccepted.size).toBe(1);
  });

  it("counts an un-accept made this session, and skips assets that take no accept", () => {
    const a = asset();
    expect(
      referenceBulkAccept(
        [a],
        {},
        {
          "reference:paperBag": { variantId: "v-1", status: "none" },
        },
      ).unaccepted.size,
    ).toBe(1);
    expect(
      referenceBulkAccept([asset({ variantId: null, variantStatus: "none" })], {}, {}).unaccepted
        .size,
    ).toBe(0);
  });
});
