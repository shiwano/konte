import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { StateManager } from "../state/index.js";
import { SCHEMA_VERSION } from "../types/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("StateManager.init", () => {
  it("creates state.json with correct contents", async () => {
    const manager = await StateManager.init(tmpDir);
    const state = manager.getState();

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.assets).toEqual({});
  });

  it("throws STATE_ALREADY_EXISTS on duplicate init", async () => {
    await StateManager.init(tmpDir);

    await expect(StateManager.init(tmpDir)).rejects.toThrow(KonteError);
    await expect(StateManager.init(tmpDir)).rejects.toThrow("already exists");
  });
});

describe("StateManager.load", () => {
  it("loads valid state.json", async () => {
    await StateManager.init(tmpDir);
    const manager = await StateManager.load(tmpDir);
    const state = manager.getState();

    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("throws STATE_NOT_FOUND when file does not exist", async () => {
    await expect(StateManager.load(tmpDir)).rejects.toThrow(KonteError);
    await expect(StateManager.load(tmpDir)).rejects.toThrow("not found");
  }, 10_000);

  it("does not recover a leftover temp — recovery is reserved for withLock", async () => {
    await StateManager.init(tmpDir);
    const statePath = path.join(tmpDir, "konte.state.json");
    const raw = await fs.readFile(statePath, "utf-8");
    // Simulate a crash before the first atomic rename committed: a valid temp, no main file.
    await fs.writeFile(path.join(tmpDir, ".konte.state.json.abc123.tmp"), raw, "utf-8");
    await fs.rm(statePath);

    await expect(StateManager.load(tmpDir)).rejects.toThrow("not found");
  });

  it("recovers a leftover temp under withLock", async () => {
    await StateManager.init(tmpDir);
    const statePath = path.join(tmpDir, "konte.state.json");
    const raw = await fs.readFile(statePath, "utf-8");
    await fs.writeFile(path.join(tmpDir, ".konte.state.json.abc123.tmp"), raw, "utf-8");
    await fs.rm(statePath);

    const schemaVersion = await StateManager.withLock(
      tmpDir,
      async (mgr) => mgr.getState().schemaVersion,
    );
    expect(schemaVersion).toBe(SCHEMA_VERSION);
    await fs.access(statePath);
  });

  it("throws VALIDATION_FAILED for invalid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "konte.state.json"), "not json", "utf-8");

    await expect(StateManager.load(tmpDir)).rejects.toThrow(KonteError);
    await expect(StateManager.load(tmpDir)).rejects.toThrow("Invalid JSON");
  });

  it("throws VALIDATION_FAILED for schema mismatch", async () => {
    await fs.writeFile(
      path.join(tmpDir, "konte.state.json"),
      JSON.stringify({ invalid: true }),
      "utf-8",
    );

    await expect(StateManager.load(tmpDir)).rejects.toThrow(KonteError);
    await expect(StateManager.load(tmpDir)).rejects.toThrow("validation failed");
  });
});

describe("reserveVariantId", () => {
  it("generates unique variant IDs", async () => {
    const manager = await StateManager.init(tmpDir);

    const id1 = manager.reserveVariantId("video:shot.01.motion");
    expect(id1).toMatch(/^v-.{8}$/);

    const id2 = manager.reserveVariantId("video:shot.01.motion");
    expect(id2).toMatch(/^v-.{8}$/);
    expect(id2).not.toBe(id1);

    const id3 = manager.reserveVariantId("video:shot.01.motion");
    expect(id3).toMatch(/^v-.{8}$/);
    expect(id3).not.toBe(id1);
    expect(id3).not.toBe(id2);
  });

  // `createdAt` is what "newest" means, so a wall clock that steps back (a VM's time sync, an NTP
  // correction) must not leave a take sorting older than the one it replaces — the address would
  // resolve to the take that was superseded.
  it("stamps past the newest take when the clock has gone backwards", async () => {
    const manager = await StateManager.init(tmpDir);
    const address = "video:shot.01.motion";
    const older = manager.reserveVariantId(address);
    const future = new Date(Date.now() + 60_000).toISOString();
    manager.getAssetState(address).variants![older]!.createdAt = future;

    const newer = manager.reserveVariantId(address);
    const variants = manager.getAssetState(address).variants!;
    expect(variants[newer]!.createdAt > future).toBe(true);
  });

  it("stamps the wall clock when it has not", async () => {
    const manager = await StateManager.init(tmpDir);
    const address = "video:shot.01.motion";
    const before = new Date().toISOString();
    manager.reserveVariantId(address);
    const [, variant] = Object.entries(manager.getAssetState(address).variants!)[0]!;
    expect(variant.createdAt >= before).toBe(true);
    expect(variant.createdAt <= new Date().toISOString()).toBe(true);
  });

  it("auto-creates asset state for unregistered assets", async () => {
    const manager = await StateManager.init(tmpDir);

    manager.reserveVariantId("video:shot.01.newpart");
    const target = manager.getAssetState("video:shot.01.newpart");

    expect(Object.keys(target.variants!)).toHaveLength(1);
    const variant = Object.values(target.variants!)[0]!;
    expect(variant.status).toBe("none");
  });
});

describe("setAccepted / setUnaccepted", () => {
  it("sets variant as accepted", async () => {
    const manager = await StateManager.init(tmpDir);
    const variantId = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", variantId);

    const target = manager.getAssetState("video:shot.01.motion");
    expect(target.variants![variantId]!.status).toBe("accepted");
  });

  it("clears accepted status when unaccepting the accepted variant", async () => {
    const manager = await StateManager.init(tmpDir);
    const variantId = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", variantId);
    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(variantId);

    manager.setUnaccepted("video:shot.01.motion", variantId);
    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBeNull();
    expect(manager.getAssetState("video:shot.01.motion").variants![variantId]!.status).toBe("none");
  });

  it("throws when unaccepting a variant that is not accepted", async () => {
    const manager = await StateManager.init(tmpDir);
    const variantId = manager.reserveVariantId("video:shot.01.motion");

    expect(() => manager.setUnaccepted("video:shot.01.motion", variantId)).toThrow(/not accepted/);
  });

  // The take an accept moves off is dismissed when the caller had it in front of them, and left
  // undecided otherwise.
  it("dismisses the old accepted take only when it was among the candidates", async () => {
    const manager = await StateManager.init(tmpDir);
    const v1 = manager.reserveVariantId("video:shot.01.motion");
    const v2 = manager.reserveVariantId("video:shot.01.motion");
    const v3 = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", v1);
    manager.setAccepted("video:shot.01.motion", v2);
    expect(manager.getAssetState("video:shot.01.motion").variants![v1]!.status).toBe("none");
    expect(manager.getAssetState("video:shot.01.motion").variants![v1]!.decidedAt).toBeNull();

    manager.setAccepted("video:shot.01.motion", v3, { dismiss: [v2] });
    expect(manager.getAssetState("video:shot.01.motion").variants![v2]!.status).toBe("dismissed");
    expect(manager.getAssetState("video:shot.01.motion").variants![v3]!.status).toBe("accepted");
    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(v3);
  });

  it("throws VARIANT_NOT_FOUND for non-existent variant", async () => {
    const manager = await StateManager.init(tmpDir);
    manager.reserveVariantId("video:shot.01.motion");

    expect(() => manager.setAccepted("video:shot.01.motion", "v999")).toThrow(KonteError);
    expect(() => manager.setAccepted("video:shot.01.motion", "v999")).toThrow("not found");
  });

  it("stamps decidedAt (decision moment) on accept", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    expect(manager.getAssetState("video:shot.01.motion").variants![vid]!.decidedAt).toBeNull();

    manager.setAccepted("video:shot.01.motion", vid);

    const decidedAt = manager.getAssetState("video:shot.01.motion").variants![vid]!.decidedAt;
    expect(typeof decidedAt).toBe("string");
    expect(() => new Date(decidedAt as string).toISOString()).not.toThrow();
  });

  it("dismisses the rival takes an accept was made among", async () => {
    const manager = await StateManager.init(tmpDir);
    const chosen = manager.reserveVariantId("video:shot.01.motion");
    const passedOver = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", chosen, { dismiss: [chosen, passedOver] });

    const variants = manager.getAssetState("video:shot.01.motion").variants!;
    expect(variants[chosen]!.status).toBe("accepted");
    expect(variants[passedOver]!.status).toBe("dismissed");
    expect(variants[passedOver]!.decidedAt).toBe(variants[chosen]!.decidedAt);
  });

  // A take something was patched off is the "before" of its correction, not a rival that lost.
  it("leaves a take that has been patched undecided", async () => {
    const manager = await StateManager.init(tmpDir);
    const source = manager.reserveVariantId("video:shot.01.motion");
    const patched = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![patched]!.derivedFrom = source;
    const chosen = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", chosen, { dismiss: [source, patched] });

    const variants = manager.getAssetState("video:shot.01.motion").variants!;
    expect(variants[source]!.status).toBe("none");
    expect(variants[patched]!.status).toBe("dismissed");
  });

  // The same rule for the take the accept moves OFF: accepting a correction says nothing against
  // the take it corrects, which `konte patch remove` may hand back at any time.
  it("leaves the accepted take undecided when the accept moves to its correction", async () => {
    const manager = await StateManager.init(tmpDir);
    const address = "video:shot.01.motion";
    const source = manager.reserveVariantId(address);
    const correction = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![correction]!.derivedFrom = source;
    manager.setAccepted(address, source);

    manager.setAccepted(address, correction, { dismiss: [source] });

    const variants = manager.getAssetState(address).variants!;
    expect(variants[correction]!.status).toBe("accepted");
    expect(variants[source]!.status).toBe("none");
    expect(variants[source]!.decidedAt).toBeNull();
  });

  it("clears decidedAt when an accept is cleared", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.setAccepted("video:shot.01.motion", vid);

    manager.setUnaccepted("video:shot.01.motion", vid);

    expect(manager.getAssetState("video:shot.01.motion").variants![vid]!.decidedAt).toBeNull();
  });
});

describe("removeVariant", () => {
  it("removes a variant from asset state", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid1 = manager.reserveVariantId("video:shot.01.motion");
    const vid2 = manager.reserveVariantId("video:shot.01.motion");

    manager.removeVariant("video:shot.01.motion", vid1);

    const target = manager.getAssetState("video:shot.01.motion");
    expect(target.variants![vid1]).toBeUndefined();
    expect(target.variants![vid2]).toBeDefined();
  });

  it("clears accepted status when removing the accepted variant", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.setAccepted("video:shot.01.motion", vid);
    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(vid);

    manager.removeVariant("video:shot.01.motion", vid);

    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBeNull();
    expect(manager.getAssetState("video:shot.01.motion").variants![vid]!).toBeUndefined();
  });

  it("throws VARIANT_NOT_FOUND for non-existent variant", async () => {
    const manager = await StateManager.init(tmpDir);
    manager.reserveVariantId("video:shot.01.motion");

    expect(() => manager.removeVariant("video:shot.01.motion", "v999")).toThrow(KonteError);
    expect(() => manager.removeVariant("video:shot.01.motion", "v999")).toThrow("not found");
  });
});

describe("getAcceptedVariant", () => {
  it("returns accepted variant for address", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.setAccepted("video:shot.01.motion", vid);

    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(vid);
    expect(manager.getAcceptedVariant("video:shot.09.motion")).toBeNull();
  });
});

describe("per-profile acceptance", () => {
  it("accepts different variants for different profiles", async () => {
    const manager = await StateManager.init(tmpDir);
    const v1 = manager.reserveVariantId("video:shot.01.motion");
    const v2 = manager.reserveVariantId("video:shot.09.motion");

    manager.setAccepted("video:shot.01.motion", v1);
    manager.setAccepted("video:shot.09.motion", v2);

    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(v1);
    expect(manager.getAcceptedVariant("video:shot.09.motion")).toBe(v2);
    expect(manager.getAssetState("video:shot.01.motion").variants![v1]!.status).toBe("accepted");
    expect(manager.getAssetState("video:shot.09.motion").variants![v2]!.status).toBe("accepted");
  });

  it("does not reset status when variant is accepted in another profile", async () => {
    const manager = await StateManager.init(tmpDir);
    const v1 = manager.reserveVariantId("video:shot.01.motion");
    const v2 = manager.reserveVariantId("video:shot.01.motion");

    manager.setAccepted("video:shot.01.motion", v1);
    manager.setAccepted("video:shot.01.motion", v2);

    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBe(v2);
    expect(manager.getAssetState("video:shot.01.motion").variants![v1]!.status).toBe("none");
    expect(manager.getAssetState("video:shot.01.motion").variants![v2]!.status).toBe("accepted");
  });
});

describe("getAssetState", () => {
  it("throws ASSET_NOT_FOUND for unregistered address", async () => {
    const manager = await StateManager.init(tmpDir);

    expect(() => manager.getAssetState("video:shot.01.unknown")).toThrow(KonteError);
    expect(() => manager.getAssetState("video:shot.01.unknown")).toThrow("not found");
  });
});

describe("save", () => {
  it("persists state and leaves no .tmp file", async () => {
    const manager = await StateManager.init(tmpDir);
    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.setAccepted("video:shot.01.motion", vid);

    await manager.save();

    const statePath = path.join(tmpDir, "konte.state.json");
    const tmpPath = `${statePath}.tmp`;

    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.assets["video:shot.01.motion"].variants[vid].status).toBe("accepted");

    await expect(fs.access(tmpPath)).rejects.toThrow();
  });

  it("writes assets/.gitignore with the accepted take's directory", async () => {
    const manager = await StateManager.init(tmpDir);
    const gitignorePath = path.join(tmpDir, "assets", ".gitignore");
    expect(await fs.readFile(gitignorePath, "utf-8")).not.toContain("shot.01.motion");

    const vid = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![vid]!.file =
      `assets/video/shot.01.motion/${vid}/out.mp4`;
    manager.setAccepted("video:shot.01.motion", vid);
    await manager.save();

    expect(await fs.readFile(gitignorePath, "utf-8")).toContain(`!/video/shot.01.motion/${vid}/`);
  });

  it("retries assets/.gitignore on the next save after it failed to write", async () => {
    const manager = await StateManager.init(tmpDir);
    const gitignorePath = path.join(tmpDir, "assets", ".gitignore");
    await fs.rm(gitignorePath);
    await fs.mkdir(gitignorePath);
    manager.reserveVariantId("video:shot.01.motion");

    await expect(manager.save()).rejects.toThrow(
      expect.objectContaining({ code: "STATE_WRITE_FAILED" }),
    );

    await fs.rm(gitignorePath, { recursive: true });
    await manager.save();
    expect(await fs.readFile(gitignorePath, "utf-8")).toContain("/video/*/v-*/");
  });

  it("repairs assets/.gitignore on a save in another process that changes no state", async () => {
    await StateManager.init(tmpDir);
    const gitignorePath = path.join(tmpDir, "assets", ".gitignore");
    const expected = await fs.readFile(gitignorePath, "utf-8");
    await fs.writeFile(gitignorePath, "!/video/\n");
    const statePath = path.join(tmpDir, "konte.state.json");
    const stateMtime = (await fs.stat(statePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await StateManager.withLock(tmpDir, async () => {});

    expect(await fs.readFile(gitignorePath, "utf-8")).toBe(expected);
    expect((await fs.stat(statePath)).mtimeMs).toBe(stateMtime);
  });

  it("does not rewrite an unchanged assets/.gitignore", async () => {
    const manager = await StateManager.init(tmpDir);
    const gitignorePath = path.join(tmpDir, "assets", ".gitignore");
    const before = (await fs.stat(gitignorePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    manager.reserveVariantId("video:shot.01.motion");
    await manager.save();

    expect((await fs.stat(gitignorePath)).mtimeMs).toBe(before);
  });
});

describe("absent variants", () => {
  const address = "video:shot.01.motion";

  async function seed(): Promise<{ absent: string; present: string; accepted: string }> {
    const manager = await StateManager.init(tmpDir);
    const ids = {
      absent: manager.reserveVariantId(address),
      accepted: manager.reserveVariantId(address),
      present: manager.reserveVariantId(address),
    };
    for (const id of Object.values(ids)) {
      manager.getAssetState(address).variants![id]!.file =
        `assets/video/shot.01.motion/${id}/out.mp4`;
    }
    manager.setAccepted(address, ids.accepted);
    await manager.save();
    const presentFile = path.join(tmpDir, "assets/video/shot.01.motion", ids.present, "out.mp4");
    await fs.mkdir(path.dirname(presentFile), { recursive: true });
    await fs.writeFile(presentFile, "");
    return ids;
  }

  it("withholds an unprotected variant whose media is not on disk, and keeps an accepted one", async () => {
    const ids = await seed();
    const variants = (await StateManager.load(tmpDir)).getAssetState(address).variants!;

    expect(Object.keys(variants).sort()).toEqual([ids.accepted, ids.present].sort());
  });

  it("writes an absent variant back in its place, recording no absence", async () => {
    const ids = await seed();
    const statePath = path.join(tmpDir, "konte.state.json");
    const before = JSON.parse(await fs.readFile(statePath, "utf-8"));

    await StateManager.withLock(tmpDir, async (mgr) => {
      mgr.setDismissed(address, ids.present, true);
    });

    const after = JSON.parse(await fs.readFile(statePath, "utf-8"));
    expect(Object.keys(after.assets[address].variants)).toEqual(
      Object.keys(before.assets[address].variants),
    );
    expect(after.assets[address].variants[ids.absent]).toEqual(
      before.assets[address].variants[ids.absent],
    );
    expect(after.assets[address].variants[ids.present].status).toBe("dismissed");
  });

  it("leaves the state file untouched when a pass over absent variants changes nothing", async () => {
    await seed();
    const statePath = path.join(tmpDir, "konte.state.json");
    const before = (await fs.stat(statePath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await StateManager.withLock(tmpDir, async () => {});

    expect((await fs.stat(statePath)).mtimeMs).toBe(before);
  });

  it("removes an absent variant, which the next save no longer writes back", async () => {
    const ids = await seed();

    await StateManager.withLock(tmpDir, async (mgr) => {
      expect(Object.keys(mgr.getRecordedState().assets[address]!.variants!)).toContain(ids.absent);
      mgr.removeVariant(address, ids.absent);
    });

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, "konte.state.json"), "utf-8"));
    expect(Object.keys(raw.assets[address].variants).sort()).toEqual(
      [ids.accepted, ids.present].sort(),
    );
  });

  it("names an absent variant as absent, not as gone from state", async () => {
    const ids = await seed();
    const manager = await StateManager.load(tmpDir);

    expect(() => manager.resolveVariantAddress(ids.absent)).toThrow(
      expect.objectContaining({ code: "VARIANT_ABSENT" }),
    );
    expect(() => manager.resolveVariantAddress("v-unknown")).toThrow(
      expect.objectContaining({ code: "VARIANT_NOT_FOUND" }),
    );
  });
});

describe("directionAcceptance", () => {
  it("is absent on a fresh state and round-trips a per-part acceptance", async () => {
    const manager = await StateManager.init(tmpDir);
    expect(manager.getDirectionAcceptance()).toBeNull();

    manager.setDirectionAcceptance({
      parts: {
        "direction:brief.logline": { partHash: "abc123", acceptedAt: "2026-01-01T00:00:00Z" },
      },
      whole: null,
    });
    await manager.save();

    const reloaded = await StateManager.load(tmpDir);
    const acceptance = reloaded.getDirectionAcceptance();
    expect(acceptance?.parts["direction:brief.logline"]?.partHash).toBe("abc123");
    expect(acceptance?.whole).toBeNull();
  });

  it("clears an acceptance so the spend gate re-blocks", async () => {
    const manager = await StateManager.init(tmpDir);
    manager.setDirectionAcceptance({
      parts: {},
      whole: { hash: "hash-one", acceptedAt: "2026-01-01T00:00:00.000Z" },
    });
    manager.setDirectionAcceptance(null);
    expect(manager.getDirectionAcceptance()).toBeNull();

    await manager.save();
    const reloaded = await StateManager.load(tmpDir);
    expect(reloaded.getDirectionAcceptance()).toBeNull();
  });

  // A state written before acceptance became per-part records a verdict whose parts were never
  // captured. It must not be readable as a sign-off — there is no way to tell which parts of the
  // direction the human actually approved — so it loads as "nothing accepted" and is reviewed again.
  it("reads a pre-per-part acceptance as never accepted", async () => {
    await StateManager.init(tmpDir);
    const statePath = path.join(tmpDir, "konte.state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        assets: {},
        directionAcceptance: {
          directionHash: "72ee647cad58",
          acceptedAt: "2026-07-16T06:26:01.507Z",
        },
      }),
    );

    const reloaded = await StateManager.load(tmpDir);
    const acceptance = reloaded.getDirectionAcceptance();
    expect(acceptance?.parts).toEqual({});
    expect(acceptance?.whole).toBeNull();
  });
});
