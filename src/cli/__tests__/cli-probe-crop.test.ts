import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acceptDirection, ctx, initWorkspace, run, useTempWorkspace } from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const studio = asset("studio", internalTestPlate, { width: 64, height: 64, color: "#eee" });
  const desk = asset("desk", adapters.imageCrop, {
    image: studio,
    x: 8,
    y: 8,
    width: 32,
    height: 16,
    outWidth: 32,
    outHeight: 16,
  });
  return { studio, desk };
});
`;

const ANIMATIC_TSX = `import { defineAnimatic } from "konte";
import direction from "./direction";

export default defineAnimatic(direction, { timeline: () => ({ shots: [] }) });
`;

const VIDEO_TSX = `import { Composition, defineVideo, defineDirection } from "konte";

const direction = defineDirection({
  brief: { logline: "test" },
  characters: {},
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", holds: ["studioMark"] },
  },
  policy: {
    format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
    lang: "en",
    speech: "free",
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "ordinary", action: "test shot", setup: "front", duration: 2 , lineup: [] }],
    waivers: { "location-unreferenced_studio": "reference stage exposes no studio plate" },
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => (<Composition><div /></Composition>)),
  }),
});
`;

async function initAndGenerate(): Promise<string> {
  const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "crop"));
  await fs.writeFile(path.join(projectDir, "reference.tsx"), REFERENCE_TS);
  await fs.writeFile(path.join(projectDir, "video.tsx"), VIDEO_TSX);
  // The template board is built on the template's reference stage, which this one replaces.
  await fs.writeFile(path.join(projectDir, "animatic.tsx"), ANIMATIC_TSX);
  await acceptDirection(projectDir);
  await run(["generate", "reference"], projectDir);
  await run(["job", "wait"], projectDir).catch(() => undefined);
  return projectDir;
}

describe("probe crop", () => {
  it("outlines each window on the source and renders it at the canvas", async () => {
    const projectDir = await initAndGenerate();
    const { stdout, stderr } = await run(
      ["probe", "crop", "reference:studio", "--rect", "0,0,32,16", "--rect", "16,16,48,27"],
      projectDir,
    );
    expect(stderr).toMatch(/^1 \(.+\): x=0 y=0 32x16 -> 1024x576$/m);
    expect(stderr).toMatch(/^2 \(.+\): x=16 y=16 48x27 -> 1024x576$/m);
    // Only the first window's aspect misses the canvas, so only it is called out.
    expect(stderr).toContain("warning: window 1 is 2.00:1");
    expect(stderr).not.toContain("warning: window 2 is");
    const sheets = stdout.trim().split("\n");
    expect(sheets).toHaveLength(2);
    for (const sheet of sheets) expect(existsSync(sheet)).toBe(true);
  });

  it("shows an imageCrop's own window as current, cut from its master", async () => {
    const projectDir = await initAndGenerate();
    const { stderr } = await run(
      ["probe", "crop", "reference:desk", "--rect", "0,24,32,16"],
      projectDir,
    );
    // The declared window is reported in the master's pixels, not the crop's.
    expect(stderr).toMatch(/^current \(.+\): x=8 y=8 32x16 -> 32x16$/m);
    expect(stderr).toMatch(/^1 \(.+\): x=0 y=24 32x16 -> /m);
  });

  it("refuses a window outside the source", async () => {
    const projectDir = await initAndGenerate();
    await expect(
      run(["probe", "crop", "reference:studio", "--rect", "50,50,32,32"], projectDir),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("outside it: 1") });
  });

  it("asks for a window when the image has none of its own", async () => {
    const projectDir = await initAndGenerate();
    await expect(run(["probe", "crop", "reference:studio"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("pass --rect"),
    });
  });
});
