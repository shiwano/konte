import { describe, expect, it } from "vitest";
import type { Direction } from "../../../../core/dsl/direction.js";
import { referenceGroups } from "../reference-groups.js";

const direction = {
  characters: {
    cook: {
      name: "the cook",
      promptDepiction: "boy",
      description: "A boy in an apron.",
      voice: { id: "cookVoice", description: "Bright." },
    },
    rival: { name: "the rival", promptDepiction: "woman", description: "A woman." },
  },
  narrator: { id: "cookVoice", description: "The cook, older." },
  props: { pan: { name: "the pan", promptDepiction: "pan", description: "A pan." } },
  locations: {
    kitchen: {
      name: "the kitchen",
      description: "A kitchen.",
      landmarks: { stove: { name: "the stove" }, window: { name: "the window" } },
      views: { front: { holds: ["window"] }, top: { holds: ["stove"] } },
    },
  },
  policy: { song: "theme" },
  sequence: {
    id: "act1",
    shots: [
      {
        id: "01",
        script: [
          { character: "cook", text: "Almost ready.", acting: "Humming." },
          { character: "rival", text: "Something is burning." },
          { narration: "It was." },
        ],
      },
    ],
  },
} as unknown as Direction;

const exposed = ["photo", "cook", "cookVoice", "pan", "kitchen", "view.kitchen.top", "theme"];

describe("referenceGroups", () => {
  const groups = referenceGroups(direction, exposed);
  const group = (id: string) => groups.find((g) => g.id === id);

  it("puts a character's voice sample under its look, with the lines it speaks", () => {
    expect(group("character:cook")?.members).toEqual([
      { address: "reference:cook", role: "look" },
      {
        address: "reference:cookVoice",
        role: "voice",
        lines: [{ text: "Almost ready.", acting: "Humming." }],
      },
    ]);
  });

  it("puts a location's views under its master, each with the landmarks it sees", () => {
    expect(group("location:kitchen")?.members).toEqual([
      { address: "reference:kitchen", role: "master", holds: ["the window"] },
      { address: "reference:view.kitchen.top", role: "view", view: "top", holds: ["the stove"] },
    ]);
  });

  it("lists a sample cast twice under both subjects", () => {
    expect(group("narrator")?.members).toEqual([
      { address: "reference:cookVoice", role: "voice", lines: [{ text: "It was.", acting: null }] },
    ]);
  });

  it("drops a subject none of whose assets the stage exposes", () => {
    expect(group("character:rival")).toBeUndefined();
  });

  it("files what no roster entry claims as a material of its own", () => {
    expect(groups.filter((g) => g.kind === "material").map((g) => g.members[0]!.address)).toEqual([
      "reference:photo",
    ]);
    expect(group("song")?.members).toEqual([{ address: "reference:theme", role: "song" }]);
  });

  it("files every asset as a material with no direction", () => {
    expect(referenceGroups(null, ["a", "b"]).map((g) => g.kind)).toEqual(["material", "material"]);
  });
});
