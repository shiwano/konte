import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Direction } from "../../core/dsl/direction.js";
import { StateManager } from "../../core/state/index.js";
import {
  loadDirectionIfPresent,
  unsatisfiedCharacters,
  unsatisfiedVoices,
} from "../load-definition.js";
import { loadCheckContext, spendGate } from "../finding-gates.js";
import { DIRECTION_SECTIONS } from "../../core/address.js";
import { applyDirectionSectionDecisions } from "../../core/direction-acceptance.js";

let dir: string;
let manager: StateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-chargate-"));
  manager = await StateManager.init(dir);
});

function directionWith(ids: string[], unframed: string[] = []): Direction {
  return {
    characters: Object.fromEntries(
      [...ids, ...unframed].map((id) => [id, { name: id, description: "d" }]),
    ),
    sequence: {
      lens: "test",
      pleasure: "delight",
      shots: ids.length > 0 ? [{ id: "01", action: "a", setup: "s", lineup: ids }] : [],
    },
  } as unknown as Direction;
}

// With an output file: nothing resolves to a fileless take, so the gate reads one as unsatisfied.
function accept(id: string): void {
  const address = `reference:${id}`;
  const vid = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![vid]!.file = `assets/${id}.png`;
  manager.setAccepted(address, vid);
}

async function provideFile(id: string): Promise<void> {
  const filePath = path.resolve(dir, "assets", "files", `${id}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "x");
}

describe("unsatisfiedCharacters", () => {
  it("flags a generative character with no accepted variant", () => {
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith(["hero"]),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("requires acceptance for a character passing through a shot", () => {
    const direction = directionWith(["hero"], ["crow"]);
    direction.sequence.shots![0] = {
      ...direction.sequence.shots![0]!,
      passing: ["crow"],
    } as NonNullable<Direction["sequence"]["shots"]>[number];
    accept("hero");
    expect(unsatisfiedCharacters({ manager, direction }).map((c) => c.id)).toEqual(["crow"]);
    accept("crow");
    expect(unsatisfiedCharacters({ manager, direction })).toEqual([]);
  });

  it("clears a generative character once it has an accepted variant", () => {
    accept("hero");
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith(["hero"]),
    });
    expect(unsatisfied).toEqual([]);
  });

  it("flags a file character whose file is on disk but unaccepted", async () => {
    await provideFile("hero");
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith(["hero"]),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("flags a file character whose file is missing", () => {
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith(["hero"]),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("asks nothing of a character no frame's lineup holds", () => {
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith(["hero"], ["singer"]),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("returns nothing when no characters are declared", () => {
    const unsatisfied = unsatisfiedCharacters({
      manager,
      direction: directionWith([]),
    });
    expect(unsatisfied).toEqual([]);
  });
});

// A cast voice is a reference asset like a character's look, satisfied the same way.
describe("unsatisfiedVoices", () => {
  function voicedDirection(): Direction {
    return {
      characters: {
        hero: {
          name: "hero",
          description: "d",
          voice: { id: "heroVoice", description: "v" },
          promptDepiction: "hero",
        },
        extra: { name: "extra", description: "d", promptDepiction: "extra" },
      },
      narrator: { id: "narratorVoice", description: "v" },
      sequence: { lens: "test", pleasure: "delight", shots: [] },
    } as unknown as Direction;
  }

  it("flags every cast sample with no accepted variant, and nothing for an uncast character", () => {
    const unsatisfied = unsatisfiedVoices({
      manager,
      direction: voicedDirection(),
    });
    expect(unsatisfied.map((v) => v.assetId)).toEqual(["heroVoice", "narratorVoice"]);
  });

  it("clears each sample once it is accepted, a file one included", () => {
    accept("heroVoice");
    accept("narratorVoice");
    const unsatisfied = unsatisfiedVoices({
      manager,
      direction: voicedDirection(),
    });
    expect(unsatisfied).toEqual([]);
  });

  it("says nothing when the direction casts no voice at all", () => {
    expect(
      unsatisfiedVoices({
        manager,
        direction: directionWith(["hero"]),
      }),
    ).toEqual([]);
  });

  it("names who each sample belongs to", () => {
    expect(unsatisfiedVoices({ manager, direction: voicedDirection() })).toEqual([
      { assetId: "heroVoice", who: "hero (hero)" },
      { assetId: "narratorVoice", who: "the narrator" },
    ]);
  });
});

// The stage scope lives in the spend gate, not in `unsatisfiedVoices` — testing the list alone would
// leave the scope free to be removed or reversed unnoticed.
describe("the spend gate's voice scope", () => {
  const gate = async (root: string, stage: "reference" | "animatic" | "video") =>
    spendGate(await loadCheckContext({ videoRoot: root }), {
      command: "generate",
      stage,
      assetPaths: [],
      targeted: false,
    });

  async function project(): Promise<string> {
    const root = await fs.mkdtemp(path.join(tmpdir(), "konte-voicegate-"));
    await fs.writeFile(
      path.join(root, "direction.ts"),
      `export default {
        brief: { logline: "l" },
        characters: {
          hero: { name: "Hero", description: "d", voice: { id: "heroVoice", description: "warm" }, promptDepiction: "hero", },
        },
        locations: { here: { name: "H", description: "h", landmarks: { hereMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
        setups: {
          near: { name: "near", description: "in close", location: "here", framing: "close", view: "front", holds: ["hereMark"], within: null },
          wide: { name: "wide", description: "the room", location: "here", framing: "medium", view: "front", holds: ["hereMark"] },
          thing: { name: "the thing", description: "filling the frame", location: "here", framing: "insert", view: "front", holds: [] },
        },
        policy: { format: { fps: 24, size: { megapixels: 0.001024, delivery: { width: 32, height: 32 } } }, lang: "en" },
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            { id: "01", role: "ordinary", action: "A calm room", setup: "near", duration: 3 , lineup: [] },
            { id: "02", role: "disruption", action: "The door slams", setup: "wide", duration: 2 , lineup: [] },
            { id: "03", role: "pressure", action: "The clock ticks on", setup: "near", duration: 3 , lineup: [] },
            {
              id: "04",
              role: "hero",
              action: "Hero opens the door",
              setup: "thing",
              duration: 4,
              script: [{ character: "hero", text: "hi" }],
             lineup: [] },
          ],
        },
      }`,
    );
    await fs.writeFile(
      path.join(root, "reference.tsx"),
      `export default {
        shots: [],
        topLevelAssets: {
          hero: { kind: "file", path: "assets/files/hero.png" },
          heroVoice: { kind: "file", path: "assets/files/hero.wav" },
          here: { kind: "file", path: "assets/files/here.png" },
        },
        exposedAssetNames: ["hero", "heroVoice", "here"],
      };`,
    );
    const mgr = await StateManager.init(root);
    const direction = (await loadDirectionIfPresent(root))!;
    mgr.setDirectionAcceptance(
      applyDirectionSectionDecisions(
        direction,
        null,
        Object.fromEntries(DIRECTION_SECTIONS.map((s) => [s, true])),
      ),
    );
    // The look and the location are accepted; the voice sample is deliberately absent.
    for (const id of ["hero", "here"]) {
      const address = `reference:${id}`;
      const vid = mgr.reserveVariantId(address);
      mgr.getAssetState(address).variants![vid]!.file = `assets/files/${id}.png`;
      mgr.setAccepted(address, vid);
    }
    await mgr.save();
    return root;
  }

  // The lines are recorded on the board, so the animatic is where the TTS spend happens — gating
  // only the video would let every line be cloned from a sample nobody listened to.
  it("aborts an animatic spend while a cast voice sample is missing", async () => {
    const root = await project();
    await expect(gate(root, "animatic")).rejects.toMatchObject({
      code: "SPEND_HELD",
      message: expect.stringContaining("reference:heroVoice"),
    });
  });

  it("aborts a video spend on the same project", async () => {
    const root = await project();
    await expect(gate(root, "video")).rejects.toMatchObject({
      code: "SPEND_HELD",
      message: expect.stringContaining("reference:heroVoice"),
    });
  });

  // The reference stage is where the sample itself is made, so it is exempt — gating it would leave
  // no way to produce the thing the gate demands.
  it("lets a reference spend through", async () => {
    const root = await project();
    await expect(gate(root, "reference")).resolves.toBeDefined();
  });
});
