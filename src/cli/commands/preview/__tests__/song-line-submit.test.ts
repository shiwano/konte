import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleReferenceSubmit } from "../reference-review.js";
import { StateManager } from "../../../../core/state/index.js";
import { ctx, initWorkspace, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const SONG = "reference:song";

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: { konte: { name: "Konte", promptDepiction: "girl", description: "the singer" } },
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
    clock: { song: "song", bpm: 120, beatsPerBar: 4 },
  },
  lyrics: [{ label: "chorus", singer: "konte", lines: ["Hit the light", "Watch me move"] }],
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
});
`;

const REFERENCE_TS = `import { defineReference, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const music = defineComfyAsset({
  workflow: "music.json",
  description: "test adapter",
  inputs: { lyrics: { nodeId: "1", field: "lyrics", type: "spokenText" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

export default defineReference(direction, () => ({
  song: asset("song", music, { lyrics: "Hit the light\\nWatch me move" }),
}));
`;

async function project(): Promise<{ videoRoot: string; variantId: string }> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "reference.tsx"), REFERENCE_TS);
  const sm = await StateManager.load(videoRoot);
  const variantId = sm.reserveVariantId(SONG);
  const variant = sm.getAssetState(SONG).variants![variantId]!;
  variant.file = "/tmp/song.mp3";
  variant.song = {
    bpm: 120,
    downbeatSec: 0.5,
    sectionSecs: [],
    phrases: null,
    analyzedAt: "2026-09-30T00:00:00.000Z",
  };
  await sm.save();
  return { videoRoot, variantId };
}

async function submit(videoRoot: string, body: Record<string, unknown>): Promise<Response> {
  const defs = await loadPreviewDefinitions({
    videoRoot,
    videoPath: path.join(videoRoot, "video.tsx"),
    mode: "reference-preview",
  });
  return handleReferenceSubmit(
    videoRoot,
    null,
    defs.reference!,
    defs.direction,
    defs.animatic,
    new Request("http://127.0.0.1/api/reference/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addedFeedback: [], feedbackPatches: [], ...body }),
    }),
  );
}

describe("handleReferenceSubmit — lyric lines placed on the song", () => {
  it("writes them to the take with the accept they were placed for", async () => {
    const { videoRoot, variantId } = await project();
    const res = await submit(videoRoot, {
      decisions: [{ address: SONG, variantId, status: "accepted" }],
      songLines: [
        { variantId, key: "1.1", span: { startSec: 0.5, endSec: 2 } },
        { variantId, key: "1.2", span: { startSec: 2.5, endSec: 4 } },
      ],
    });
    expect(res.status).toBe(200);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(SONG)).toBe(variantId);
    expect(sm.getAssetState(SONG).variants![variantId]!.song?.lines?.["1.2"]).toMatchObject({
      text: "Watch me move",
      startSec: 2.5,
      endSec: 4,
    });
  });

  it("refuses the accept while a line stands placed nowhere on the take", async () => {
    const { videoRoot, variantId } = await project();
    const res = await submit(videoRoot, {
      decisions: [{ address: SONG, variantId, status: "accepted" }],
      songLines: [{ variantId, key: "1.2", span: { startSec: 2.5, endSec: 4 } }],
    });
    const payload = (await res.json()) as {
      skippedDecisions: Array<{ address: string; reason: string }>;
    };
    expect(payload.skippedDecisions).toEqual([
      expect.objectContaining({ address: SONG, reason: expect.stringContaining("(1.1)") }),
    ]);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(SONG)).toBeNull();
    // The line placed beside it still lands.
    expect(sm.getAssetState(SONG).variants![variantId]!.song?.lines?.["1.2"]).toBeTruthy();
  });

  it("reports a line it cannot place and writes nothing for it", async () => {
    const { videoRoot, variantId } = await project();
    const res = await submit(videoRoot, {
      songLines: [{ variantId, key: "3.1", span: { startSec: 2.5, endSec: 4 } }],
    });
    const payload = (await res.json()) as {
      skippedDecisions: Array<{ address: string; reason: string }>;
    };
    expect(payload.skippedDecisions).toEqual([
      expect.objectContaining({ address: SONG, reason: expect.stringMatching(/^line 3\.1:/) }),
    ]);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAssetState(SONG).variants![variantId]!.song?.lines).toBeUndefined();
  });
});
