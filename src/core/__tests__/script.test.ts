import { describe, expect, it } from "vitest";
import { type ScriptLine, scriptLinesToView } from "../types/script.js";

// The one projection every printed script goes through — `konte inspect`, the direction preview, the
// animatic band. A character line reads as the character's NAME (the `action` prose names them that
// way), a mob line as its free label, a narration line as no speaker at all.
describe("scriptLinesToView", () => {
  const roster = new Map([["cat", "the cat"]]);

  it("resolves a character id to its roster name", () => {
    expect(scriptLinesToView([{ character: "cat", text: "meow" }], roster)).toEqual([
      { speaker: "the cat", text: "meow", acting: null },
    ]);
  });

  it("falls back to the raw id with no roster at hand", () => {
    expect(scriptLinesToView([{ character: "cat", text: "meow" }])).toEqual([
      { speaker: "cat", text: "meow", acting: null },
    ]);
  });

  it("keeps a mob speaker's label and leaves narration speaker-less", () => {
    expect(
      scriptLinesToView([{ speaker: "群衆", text: "おお" }, { narration: "朝が来た" }], roster),
    ).toEqual([
      { speaker: "群衆", text: "おお", acting: null },
      { speaker: null, text: "朝が来た", acting: null },
    ]);
  });

  it("carries a line's acting note through", () => {
    expect(
      scriptLinesToView(
        [{ character: "cat", text: "meow", acting: "wheedling, drawn out" }],
        roster,
      ),
    ).toEqual([{ speaker: "the cat", text: "meow", acting: "wheedling, drawn out" }]);
  });

  it("maps an absent script to nothing", () => {
    expect(scriptLinesToView(undefined)).toEqual([]);
  });

  // Only a character has a performance to direct, and the refusal is the type's — the field is
  // `never` on the other two branches, so `tsc` blames the note where it was written.
  it("refuses an acting note on a mob or narration line", () => {
    const lines: ScriptLine[] = [
      // @ts-expect-error -- a mob is a texture, not a performance
      { speaker: "群衆", text: "おお", acting: "低く、ばらけて" },
      // @ts-expect-error -- narration is one voice held level across the piece
      { narration: "朝が来た", acting: "静かに" },
    ];
    expect(scriptLinesToView(lines)).toEqual([
      { speaker: "群衆", text: "おお", acting: null },
      { speaker: null, text: "朝が来た", acting: null },
    ]);
  });
});
