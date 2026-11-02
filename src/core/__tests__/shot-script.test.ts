import { describe, expect, it } from "vitest";
import { makeShotScript } from "../dsl/shot-script.js";

describe("makeShotScript", () => {
  it("keys a line's words by who says them, whichever variant carries them", () => {
    const script = makeShotScript([
      { character: "cat", text: "にゃあ" },
      { speaker: "群衆", text: "おお" },
      { narration: "朝が来た" },
    ]);

    expect(script.cat).toEqual(["にゃあ"]);
    expect(script.speaker).toEqual(["おお"]);
    expect(script.narration).toEqual(["朝が来た"]);
  });

  it("keeps one speaker's lines in shot order", () => {
    const script = makeShotScript([
      { character: "cat", text: "一本目" },
      { narration: "あいだ" },
      { character: "cat", text: "二本目" },
    ]);

    expect(script.cat).toEqual(["一本目", "二本目"]);
  });

  it("gathers every mob line under `speaker`, whatever each one is labelled", () => {
    const script = makeShotScript([
      { speaker: "群衆", text: "おお" },
      { speaker: "受付", text: "こちらです" },
    ]);

    expect(script.speaker).toEqual(["おお", "こちらです"]);
  });

  it("carries only the shot's own speakers — no inherited member to shadow", () => {
    const script = makeShotScript([{ character: "cat", text: "にゃあ" }]);

    expect(Object.keys(script)).toEqual(["cat"]);
    expect(Object.getPrototypeOf(script)).toBeNull();
  });

  it("a roster id named after an array method is just a key here", () => {
    const script = makeShotScript([{ character: "map", text: "ぶつからない" }]);
    expect(script.map).toEqual(["ぶつからない"]);
  });
});
