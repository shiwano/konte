import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { castReferenceAddresses, loadCastReferenceAddresses } from "../characters.js";
import type { Direction } from "../dsl/direction.js";

describe("castReferenceAddresses", () => {
  it("maps each character id to its reference address", () => {
    const direction = {
      characters: {
        hero: { name: "Hero", description: "the lead", promptDepiction: "hero" },
        rival: { name: "Rival", description: "the foil", promptDepiction: "rival" },
      },
      sequence: { lens: "test", pleasure: "delight", shots: [] },
    } as unknown as Direction;

    expect(castReferenceAddresses(direction)).toEqual(["reference:hero", "reference:rival"]);
  });

  // The sample a line is cloned from is a human call like the look, and it is audio — which a
  // stem-rooted accept walk would otherwise sign off sideways.
  it("maps every cast voice sample too, the characters' and the narrator's", () => {
    const direction = {
      characters: {
        hero: {
          name: "Hero",
          description: "the lead",
          voice: { id: "heroVoice", description: "v" },
          promptDepiction: "hero",
        },
        mute: { name: "Mute", description: "silent", promptDepiction: "mute" },
      },
      narrator: { id: "narratorVoice", description: "v" },
      sequence: { lens: "test", pleasure: "delight", shots: [] },
    } as unknown as Direction;

    expect(castReferenceAddresses(direction)).toEqual([
      "reference:hero",
      "reference:heroVoice",
      "reference:mute",
      "reference:narratorVoice",
    ]);
  });

  it("returns an empty list when no characters are declared", () => {
    const direction = {
      sequence: { lens: "test", pleasure: "delight", shots: [] },
    } as unknown as Direction;
    expect(castReferenceAddresses(direction)).toEqual([]);
  });
});

describe("loadCastReferenceAddresses", () => {
  it("loads the character addresses from a project's direction.ts", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-chars-"));
    await fs.writeFile(
      path.join(dir, "direction.ts"),
      `export default {
        characters: { hero: { name: "Hero", description: "d", promptDepiction: "hero", } },
        sequence: {
          lens: "test",
          pleasure: "delight",
          shots: [{ id: "01", role: "beat", action: "s", duration: 2 }],
        },
      };`,
    );

    const addresses = await loadCastReferenceAddresses(dir);
    expect(addresses).toEqual(new Set(["reference:hero"]));
  });

  it("returns an empty set when the project has no direction.ts", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "konte-chars-"));
    expect(await loadCastReferenceAddresses(dir)).toEqual(new Set());
  });
});
