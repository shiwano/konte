import { describe, expect, it } from "vitest";
import { englishHearing } from "../hearing/en.js";
import type { StageDefinitions } from "../definition-hashes.js";
import type { Direction } from "../dsl/direction.js";
import {
  hearingWindows,
  joinHeardWindows,
  linesSaidAt,
  takeMishearing,
} from "../speech-hearing.js";

describe("hearingWindows", () => {
  it("starts a window every 15s until one reaches the end", () => {
    expect(hearingWindows(12)).toEqual([0]);
    expect(hearingWindows(40)).toEqual([0, 15, 30]);
  });
});

describe("joinHeardWindows", () => {
  it("puts each token on the take's clock, a token heard twice kept from one window", () => {
    const joined = joinHeardWindows([
      { startSec: 0, heard: { tokens: ["A", "B", "C"], timestamps: [1, 16, 18] } },
      { startSec: 15, heard: { tokens: ["B", "C", "D"], timestamps: [1, 3, 10] } },
    ]);
    expect(joined).toEqual([
      { text: "A", startSec: 1 },
      { text: "B", startSec: 16 },
      { text: "C", startSec: 18 },
      { text: "D", startSec: 25 },
    ]);
  });
});

describe("takeMishearing", () => {
  const heard = [{ text: "now is your turn", startSec: 0 }];

  it("names what a take gets wrong of the line the direction writes", () => {
    expect(
      takeMishearing(
        { lines: [{ text: "Now it is your turn.", number: 2 }], owed: ["Now it's your turn."] },
        heard,
        englishHearing,
      ),
    ).toBe('line 2: drops "it"');
  });

  it("passes a respelled line the take says as its prompt spells it", () => {
    expect(
      takeMishearing(
        { lines: [{ text: "Now it is your turn.", number: 2 }], owed: ["Now is your turn."] },
        heard,
        englishHearing,
      ),
    ).toBeNull();
  });
});

describe("linesSaidAt", () => {
  const address = "animatic:shot.01.yes";
  const definitions = {
    animatic: {
      stage: "animatic",
      prompts: [{ address, value: "Yes", spoken: true }],
      respellings: [],
    },
  } as unknown as StageDefinitions;
  const direction = {
    sequence: {
      shots: [
        {
          id: "01",
          script: [
            { character: "a", text: "Yes" },
            { character: "b", text: "No" },
            { character: "a", text: "Yes" },
          ],
        },
      ],
    },
  } as unknown as Direction;

  it("owes a line the script repeats as often as the take says it", () => {
    expect(linesSaidAt(definitions, direction, address).lines).toEqual([
      { text: "Yes", number: 1 },
    ]);
  });
});

describe("linesSaidAt over lines one inside another", () => {
  const address = "animatic:shot.01.greet";
  const definitions = (value: string) =>
    ({
      animatic: { stage: "animatic", prompts: [{ address, value, spoken: true }], respellings: [] },
    }) as unknown as StageDefinitions;
  const direction = {
    sequence: {
      shots: [
        {
          id: "01",
          script: [
            { character: "a", text: "Hello!" },
            { character: "b", text: "Hello! How are you?" },
          ],
        },
      ],
    },
  } as unknown as Direction;

  it("owes a short line said apart from the longer one holding it", () => {
    expect(
      linesSaidAt(definitions("Hello! Hello! How are you?"), direction, address).lines,
    ).toEqual([
      { text: "Hello!", number: 1 },
      { text: "Hello! How are you?", number: 2 },
    ]);
  });

  it("does not owe a short line said only inside the longer one", () => {
    expect(linesSaidAt(definitions("Hello! How are you?"), direction, address).lines).toEqual([
      { text: "Hello! How are you?", number: 2 },
    ]);
  });
});
