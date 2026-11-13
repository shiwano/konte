import { describe, expect, it } from "vitest";
import type { ReferenceAssetInfo, ReferenceGroupInfo } from "../../types.js";
import { referenceRowLabel, referenceSections } from "../reference-groups.js";

const asset = (name: string): ReferenceAssetInfo => ({
  assetName: name,
  address: `reference:${name}`,
  variantId: "v-1",
  variantStatus: "none",
  mediaKind: "image",
  imageUrl: null,
  variants: [],
  feedback: [],
});

const groups: ReferenceGroupInfo[] = [
  {
    id: "material:photo",
    kind: "material",
    name: "photo",
    members: [{ address: "reference:photo", role: "material" }],
  },
  {
    id: "location:kitchen",
    kind: "location",
    name: "the kitchen",
    members: [
      { address: "reference:kitchen", role: "master" },
      { address: "reference:view.kitchen.top", role: "view", view: "top" },
    ],
  },
  {
    id: "character:cook",
    kind: "character",
    name: "the cook",
    members: [
      { address: "reference:cook", role: "look" },
      { address: "reference:cookVoice", role: "voice" },
    ],
  },
  {
    id: "narrator",
    kind: "narrator",
    name: "the narrator",
    members: [{ address: "reference:cookVoice", role: "voice" }],
  },
];

const assets = ["photo", "kitchen", "view.kitchen.top", "cook", "cookVoice"].map(asset);

describe("referenceSections", () => {
  const sections = referenceSections(groups, assets);
  const rows = sections.flatMap((s) => s.subjects.flatMap((subject) => subject.rows));

  it("orders the page by section, the cast first and the materials last", () => {
    expect(sections.map((s) => s.title)).toEqual(["Cast", "Places", "Materials"]);
  });

  it("gives a sample cast twice a row of its own in each subject", () => {
    const voice = rows.filter((r) => r.asset.address === "reference:cookVoice");
    expect(voice.map((r) => r.key)).toEqual([
      "character:cook|reference:cookVoice",
      "narrator|reference:cookVoice",
    ]);
  });

  it("drops a member the page holds no asset for", () => {
    const [section] = referenceSections(groups, [asset("cook")]);
    expect(section!.subjects.map((s) => s.rows.map((r) => r.asset.assetName))).toEqual([["cook"]]);
  });

  it("names a row by its subject and the part it plays there", () => {
    expect(rows.map(referenceRowLabel)).toEqual([
      "the cook: Look",
      "the cook: Voice",
      "the narrator",
      "the kitchen: Master",
      "the kitchen: Top view",
      "photo",
    ]);
  });
});
