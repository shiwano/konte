import { describe, expect, it } from "vitest";
import { defineDirection, type Direction } from "../dsl/direction.js";
import { findUnheldLandmarks } from "../landmark-held-check.js";
import type { PromptOccurrence } from "../prompt-check.js";
import { directionDefaults } from "./helpers/direction.js";

const direction = defineDirection({
  ...directionDefaults,
  characters: { hero: { name: "Hero", description: "a man", promptDepiction: "hero" } },
  locations: {
    room: {
      name: "the room",
      description: "a sitting room",
      landmarks: {
        chair: { name: "the chair", promptDepiction: "red armchair", description: "left" },
        desk: { name: "the desk", promptDepiction: "writing desk", description: "right" },
        door: { name: "the door", promptDepiction: "door", description: "back" },
        frontDoor: { name: "front door", promptDepiction: "front door", description: "back" },
      },
    },
  },
  setups: {
    front: {
      name: "wide",
      description: "the room",
      location: "room",
      framing: "wide",
      view: "front",
      holds: ["chair", "desk", "frontDoor"],
    },
    chairMedium: {
      name: "chair",
      description: "the chair",
      location: "room",
      framing: "medium",
      view: "front",
      holds: ["chair", "frontDoor"],
    },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "x", setup: "front", duration: 2, lineup: [] },
      { id: "02", role: "ordinary", action: "x", setup: "chairMedium", duration: 2, lineup: [] },
      {
        id: "03",
        role: "ordinary",
        action: "x",
        setup: "chairMedium",
        duration: 2,
        lineup: [],
        lineupTo: ["hero"],
      },
      {
        id: "04",
        role: "ordinary",
        action: "x",
        setup: "chairMedium",
        duration: 2,
        lineup: [],
        coverage: true,
      },
    ],
  },
}) as unknown as Direction;

const at = (address: string, value: string): PromptOccurrence => ({
  address,
  input: "prompt",
  media: "image",
  value,
});

describe("findUnheldLandmarks", () => {
  it("names a landmark the locked-off shot's setup leaves out", () => {
    const found = findUnheldLandmarks(
      direction,
      [at("video:shot.02.motion", "He sits in the red armchair; a Writing Desk stands behind.")],
      [],
    );
    expect(found.map((f) => [f.address, f.landmarkId, f.setups])).toEqual([
      ["video:shot.02.motion", "desk", ["chairMedium"]],
    ]);
  });

  it("reads the board's own panel prompts", () => {
    const found = findUnheldLandmarks(
      direction,
      [at("animatic:shot.02.key", "the writing desk")],
      [],
    );
    expect(found.map((f) => f.address)).toEqual(["animatic:shot.02.key"]);
  });

  it("passes a landmark the setup holds", () => {
    expect(
      findUnheldLandmarks(
        direction,
        [at("video:shot.01.motion", "the writing desk and the red armchair")],
        [],
      ),
    ).toEqual([]);
  });

  it("reads a depiction as whole words", () => {
    expect(
      findUnheldLandmarks(direction, [at("video:shot.02.motion", "soft outdoor light")], []),
    ).toEqual([]);
    expect(
      findUnheldLandmarks(direction, [at("video:shot.02.motion", "a closed DOOR.")], []).map(
        (f) => f.landmarkId,
      ),
    ).toEqual(["door"]);
  });

  it("reads a depiction in a script written without spaces", () => {
    const japanese = defineDirection({
      ...directionDefaults,
      locations: {
        room: {
          name: "部屋",
          description: "居間",
          landmarks: {
            chair: { name: "椅子", promptDepiction: "椅子", description: "左" },
            desk: { name: "机", promptDepiction: "机", description: "右" },
          },
        },
      },
      setups: {
        front: {
          name: "椅子",
          description: "椅子",
          location: "room",
          framing: "medium",
          view: "front",
          holds: ["chair"],
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "x", setup: "front", duration: 2, lineup: [] },
        ],
      },
    }) as unknown as Direction;
    expect(
      findUnheldLandmarks(japanese, [at("video:shot.01.motion", "背景に机が見える。")], []).map(
        (f) => f.landmarkId,
      ),
    ).toEqual(["desk"]);
  });

  it("passes a declaration handed another shot's frame", () => {
    expect(
      findUnheldLandmarks(
        direction,
        [at("animatic:shot.02.key", "<Picture 2> holds the writing desk; in to the red armchair")],
        [{ address: "animatic:shot.02.key", sources: ["animatic:shot.01.key"] }],
      ),
    ).toEqual([]);
  });

  it("does not read an unheld depiction inside a held one", () => {
    expect(
      findUnheldLandmarks(
        direction,
        [at("video:shot.02.motion", "the front door behind the red armchair")],
        [],
      ),
    ).toEqual([]);
  });

  it("passes a shot whose frame moves by declaration", () => {
    expect(
      findUnheldLandmarks(
        direction,
        [
          at("video:shot.03.motion", "the writing desk"),
          at("video:shot.04.motion", "the writing desk"),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("reads neither a spoken line nor an audio prompt", () => {
    const mark = "<d>[English] Meet me at the writing desk.</d>";
    expect(
      findUnheldLandmarks(
        direction,
        [
          {
            ...at("video:shot.02.motion", `He sits in the red armchair. ${mark}`),
            spokenWithin: ["Meet me at the writing desk."],
            spokenMarks: [mark],
          },
          { ...at("video:shot.02.knock", "a knock on the writing desk"), media: "audio" },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("reads neither a negative prompt nor a timeline asset", () => {
    expect(
      findUnheldLandmarks(
        direction,
        [
          { ...at("video:shot.02.motion", "writing desk"), negative: true },
          at("video:timeline.bed", "writing desk"),
        ],
        [],
      ),
    ).toEqual([]);
  });
});
