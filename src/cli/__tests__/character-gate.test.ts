import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Direction } from "../../core/dsl/direction.js";
import { KonteError } from "../../core/errors.js";
import { StateManager } from "../../core/state/index.js";
import type { ReferenceDefinition } from "../../core/types/index.js";
import {
  assertCharactersAccepted,
  assertVoicesAccepted,
  gateDirectionForStage,
  loadDirectionIfPresent,
  unsatisfiedCharacters,
  unsatisfiedVoices,
} from "../load-definition.js";
import { DIRECTION_SECTIONS } from "../../core/address.js";
import { applyDirectionSectionDecisions } from "../../core/direction-acceptance.js";

let dir: string;
let manager: StateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-chargate-"));
  manager = await StateManager.init(dir);
});

function directionWith(ids: string[]): Direction {
  return {
    characters: Object.fromEntries(ids.map((id) => [id, { name: id, description: "d" }])),
    sequence: { lens: "test", pleasure: "delight", shots: [] },
  } as unknown as Direction;
}

function referenceWith(kinds: Record<string, "file" | "comfy">): ReferenceDefinition {
  const topLevelAssets: Record<string, unknown> = {};
  for (const [id, kind] of Object.entries(kinds)) {
    topLevelAssets[id] =
      kind === "file" ? { kind: "file", path: `assets/files/${id}.png` } : { kind: "comfy" };
  }
  return { shots: [], topLevelAssets } as unknown as ReferenceDefinition;
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
  it("flags a generative character with no accepted variant", async () => {
    const unsatisfied = await unsatisfiedCharacters({
      videoRoot: dir,
      manager,
      direction: directionWith(["hero"]),
      reference: referenceWith({ hero: "comfy" }),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("clears a generative character once it has an accepted variant", async () => {
    accept("hero");
    const unsatisfied = await unsatisfiedCharacters({
      videoRoot: dir,
      manager,
      direction: directionWith(["hero"]),
      reference: referenceWith({ hero: "comfy" }),
    });
    expect(unsatisfied).toEqual([]);
  });

  it("flags a file character whose file is on disk but unaccepted", async () => {
    await provideFile("hero");
    const unsatisfied = await unsatisfiedCharacters({
      videoRoot: dir,
      manager,
      direction: directionWith(["hero"]),
      reference: referenceWith({ hero: "file" }),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("flags a file character whose file is missing", async () => {
    const unsatisfied = await unsatisfiedCharacters({
      videoRoot: dir,
      manager,
      direction: directionWith(["hero"]),
      reference: referenceWith({ hero: "file" }),
    });
    expect(unsatisfied.map((c) => c.id)).toEqual(["hero"]);
  });

  it("returns nothing when no characters are declared", async () => {
    const unsatisfied = await unsatisfiedCharacters({
      videoRoot: dir,
      manager,
      direction: directionWith([]),
      reference: null,
    });
    expect(unsatisfied).toEqual([]);
  });
});

describe("assertCharactersAccepted", () => {
  it("throws CHARACTER_ACCEPTANCE_REQUIRED naming each unsatisfied character", async () => {
    const err = await assertCharactersAccepted({
      videoRoot: dir,
      manager,
      direction: directionWith(["hero", "rival"]),
      reference: referenceWith({ hero: "comfy", rival: "comfy" }),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(KonteError);
    expect((err as KonteError).code).toBe("CHARACTER_ACCEPTANCE_REQUIRED");
    expect((err as KonteError).message).toContain("reference:hero");
    expect((err as KonteError).message).toContain("reference:rival");
  });

  it("resolves when every character is accepted", async () => {
    accept("hero");
    accept("rival");
    await expect(
      assertCharactersAccepted({
        videoRoot: dir,
        manager,
        direction: directionWith(["hero", "rival"]),
        reference: referenceWith({ hero: "comfy", rival: "file" }),
      }),
    ).resolves.toBeUndefined();
  });
});

// A cast voice is a reference asset like a character's look, satisfied the same way. What
// differs is where it is enforced — `gateDirectionForStage` calls this on the video stage only.
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

  it("flags every cast sample with no accepted variant, and nothing for an uncast character", async () => {
    const unsatisfied = await unsatisfiedVoices({
      videoRoot: dir,
      manager,
      direction: voicedDirection(),
      reference: referenceWith({ heroVoice: "comfy", narratorVoice: "comfy" }),
    });
    expect(unsatisfied.map((v) => v.assetId)).toEqual(["heroVoice", "narratorVoice"]);
  });

  it("clears each sample once it is accepted, a file one included", async () => {
    accept("heroVoice");
    accept("narratorVoice");
    const unsatisfied = await unsatisfiedVoices({
      videoRoot: dir,
      manager,
      direction: voicedDirection(),
      reference: referenceWith({ heroVoice: "comfy", narratorVoice: "file" }),
    });
    expect(unsatisfied).toEqual([]);
  });

  it("says nothing when the direction casts no voice at all", async () => {
    expect(
      await unsatisfiedVoices({
        videoRoot: dir,
        manager,
        direction: directionWith(["hero"]),
        reference: referenceWith({ hero: "comfy" }),
      }),
    ).toEqual([]);
  });

  it("aborts with VOICE_ACCEPTANCE_REQUIRED, naming who each sample belongs to", async () => {
    const err = await assertVoicesAccepted({
      videoRoot: dir,
      manager,
      direction: voicedDirection(),
      reference: referenceWith({ heroVoice: "comfy", narratorVoice: "comfy" }),
    }).catch((e: unknown) => e as KonteError);
    expect(err).toBeInstanceOf(KonteError);
    expect((err as KonteError).code).toBe("VOICE_ACCEPTANCE_REQUIRED");
    expect((err as KonteError).message).toContain("reference:heroVoice");
    expect((err as KonteError).message).toContain("the narrator");
  });
});

// The stage scope lives in `gateDirectionForStage`, not in `assertVoicesAccepted` — testing the
// assert alone would leave the conditional free to be removed or reversed unnoticed.
describe("gateDirectionForStage voice scope", () => {
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
          near: { name: "near", description: "in close", location: "here", framing: "close", holds: ["hereMark"], within: null },
          wide: { name: "wide", description: "the room", location: "here", framing: "medium", holds: ["hereMark"] },
          thing: { name: "the thing", description: "filling the frame", location: "here", framing: "insert", holds: [] },
        },
        policy: { format: { fps: 24, size: { megapixels: 0.001024, delivery: { width: 32, height: 32 } } }, lang: "en", speech: "free" },
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
    await expect(
      gateDirectionForStage({ videoRoot: root, command: "generate", stage: "animatic" }),
    ).rejects.toMatchObject({ code: "VOICE_ACCEPTANCE_REQUIRED" });
  });

  it("aborts a video spend on the same project", async () => {
    const root = await project();
    await expect(
      gateDirectionForStage({ videoRoot: root, command: "generate", stage: "video" }),
    ).rejects.toMatchObject({ code: "VOICE_ACCEPTANCE_REQUIRED" });
  });

  // The reference stage is where the sample itself is made, so it is exempt — gating it would leave
  // no way to produce the thing the gate demands.
  it("lets a reference spend through", async () => {
    const root = await project();
    await expect(
      gateDirectionForStage({ videoRoot: root, command: "generate", stage: "reference" }),
    ).resolves.toBeUndefined();
  });
});
