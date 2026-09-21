import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPreviewDefinitions } from "../load-definitions.js";
import { handleReferenceSubmit } from "../reference-review.js";
import { StateManager } from "../../../../core/state/index.js";
import { ctx, initWorkspace, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const PANEL = "reference:studio";

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en", speech: "free" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", duration: 5 }],
  },
});
`;

const REFERENCE_TS = `import { defineReference, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

export default defineReference(direction, () => {
  const studio = asset("studio", imageComfy, { prompt: "a plain studio" });
  return { studio };
});
`;

// The board's one panel IS the shared reference plate — the shape that makes the address's owning
// stage the wrong thing to ask. `reference:studio` is accepted in the reference review, but its
// prerequisite is owed on the board.
const animaticTs = (moves: string) => `import { defineAnimatic, Composition, Panel } from "konte";
import direction from "./direction";
import reference from "./reference";

export default defineAnimatic(direction, {
  timeline: ({ shot }) => ({ shots: shot("01", () => <Composition>
<Panel src={reference.studio${moves}} />
</Composition>) }),
});
`;

const VIDEO_TSX = `import { Composition, Video, defineVideo, defineComfyAsset, asset } from "konte";
import direction from "./direction";

const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animate, { prompt: "a plain studio" });
      return <Composition><Video src={motion} /></Composition>;
    }),
  }),
});
`;

async function project(moves = ""): Promise<{ videoRoot: string; variantId: string }> {
  const inited = await initWorkspace(path.join(ctx.dir, "testproject"));
  const videoRoot = inited.video;
  await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
  await fs.writeFile(path.join(videoRoot, "reference.tsx"), REFERENCE_TS);
  await fs.writeFile(path.join(videoRoot, "animatic.tsx"), animaticTs(moves));
  await fs.writeFile(path.join(videoRoot, "video.tsx"), VIDEO_TSX);

  const sm = await StateManager.load(videoRoot);
  const variantId = sm.reserveVariantId(PANEL);
  sm.getAssetState(PANEL).variants![variantId]!.file = "/tmp/studio.png";
  await sm.save();
  return { videoRoot, variantId };
}

function submitRequest(body: unknown): Request {
  return new Request("http://127.0.0.1/api/reference/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readRecord(res: Response): Promise<Record<string, unknown> | null> {
  const payload = (await res.json()) as { filePath?: string | null };
  if (!payload.filePath) return null;
  return JSON.parse(await fs.readFile(payload.filePath, "utf-8")) as Record<string, unknown>;
}

// `Bun.serve` cannot be booted under vitest, so the route is not exercised end to end. The two
// halves are pinned separately: the loader below decides what the handler receives (the wiring bug
// was there — the board was never loaded in this mode), and the handler tests decide what it does
// with it.
describe("reference preview — definitions loaded", () => {
  it("loads the board, so a panel accept here can be checked against it", async () => {
    const { videoRoot } = await project();
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "reference-preview",
    });
    expect(defs.reference).not.toBeNull();
    expect(defs.animatic).not.toBeNull();
  });

  it("survives a board it cannot parse — the pool stays reviewable", async () => {
    const { videoRoot } = await project();
    await fs.writeFile(path.join(videoRoot, "animatic.tsx"), "throw new Error('broken');\n");
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "reference-preview",
    });
    expect(defs.reference).not.toBeNull();
    expect(defs.animatic).toBeNull();
  });
});

describe("animatic preview — definitions loaded", () => {
  it("survives a video.tsx it cannot parse — the board stays reviewable", async () => {
    const { videoRoot } = await project();
    await fs.writeFile(path.join(videoRoot, "video.tsx"), 'export default "unterminated;\n');
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "animatic-preview",
    });
    expect(defs.animatic).not.toBeNull();
    expect(defs.video).toBeNull();
  });
});

describe("handleReferenceSubmit — review prerequisites", () => {
  it("drops the accept for an unbound panel, keeps the comment, and says so in the record", async () => {
    const { videoRoot, variantId } = await project();
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "reference-preview",
    });

    const res = await handleReferenceSubmit(
      videoRoot,
      null,
      defs.reference!,
      defs.direction,
      defs.animatic,
      submitRequest({
        addedFeedback: [{ address: PANEL, text: "warmer light", annotation: null }],
        feedbackPatches: [],
        decisions: [{ address: PANEL, variantId, status: "accepted" }],
      }),
    );

    expect(res.status).toBe(200);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(PANEL)).toBeNull();

    const payload = (await res.clone().json()) as {
      skippedDecisions: Array<{ address: string; reason: string }>;
    };
    const record = await readRecord(res);
    const decision = (
      (record?.decisions ?? []) as Array<{ address: string; status?: string; feedback: unknown[] }>
    ).find((d) => d.address === PANEL);
    // The comment landed: feedback is applied before the decision loop, inside the same lock.
    expect(decision?.feedback).toEqual([expect.objectContaining({ text: "warmer light" })]);
    // …and the record reports what happened, not what was asked for.
    expect(decision?.status).toBeUndefined();
    // The dropped accept is named — in the record and to the page, which holds itself open on it —
    // like the animatic submit's, not silently swallowed.
    expect(record?.skippedDecisions).toEqual([expect.objectContaining({ address: PANEL })]);
    expect(payload.skippedDecisions).toEqual([expect.objectContaining({ address: PANEL })]);
  });

  it("lands the accept once the panel's movement is written", async () => {
    const { videoRoot, variantId } = await project(
      `, { blocking: "she crosses the room", camera: "fixed" }`,
    );
    const defs = await loadPreviewDefinitions({
      videoRoot,
      videoPath: path.join(videoRoot, "video.tsx"),
      mode: "reference-preview",
    });

    const res = await handleReferenceSubmit(
      videoRoot,
      null,
      defs.reference!,
      defs.direction,
      defs.animatic,
      submitRequest({
        addedFeedback: [],
        feedbackPatches: [],
        decisions: [{ address: PANEL, variantId, status: "accepted" }],
      }),
    );

    expect(res.status).toBe(200);
    const sm = await StateManager.load(videoRoot);
    expect(sm.getAcceptedVariant(PANEL)).toBe(variantId);
  });
});
