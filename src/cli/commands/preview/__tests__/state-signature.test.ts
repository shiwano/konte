import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStateSignature } from "../server.js";

describe("readStateSignature", () => {
  let videoRoot: string;
  const write = (raw: string) => fs.writeFile(path.join(videoRoot, "konte.state.json"), raw);
  const state = { schemaVersion: 1, assets: { "video:shot.01.motion": { variants: {} } } };

  beforeEach(async () => {
    videoRoot = await fs.mkdtemp(path.join(tmpdir(), "konte-state-signature-"));
  });

  afterEach(async () => {
    await fs.rm(videoRoot, { recursive: true, force: true });
  });

  it("is unchanged by a formatter's rewrite of the same state", async () => {
    await write(JSON.stringify(state, null, 2));
    const before = await readStateSignature(videoRoot);
    await write(`${JSON.stringify(state, null, 4)}\n\n`);
    expect(await readStateSignature(videoRoot)).toBe(before);
  });

  it("changes when the state does", async () => {
    await write(JSON.stringify(state, null, 2));
    const before = await readStateSignature(videoRoot);
    await write(JSON.stringify({ ...state, schemaVersion: 2 }, null, 2));
    expect(await readStateSignature(videoRoot)).not.toBe(before);
  });

  it("is null for a missing or half-written file", async () => {
    expect(await readStateSignature(videoRoot)).toBeNull();
    await write('{"schemaVersion": 1, "assets": {');
    expect(await readStateSignature(videoRoot)).toBeNull();
  });
});
