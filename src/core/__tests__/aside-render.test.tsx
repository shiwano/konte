import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFullCompositionHtml, buildShotCompositionHtml } from "../composition-builder.js";
import { Composition, Panel, asset, defineAnimatic } from "../dsl/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { testDirection } from "./helpers/direction.js";
import { animaticTimeline, asideShot, moves, shot } from "./helpers/shot.js";
import { StateManager } from "../state/index.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

let tmpDir: string;
let manager: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-aside-render-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The animatic never boards an aside, so it reaches the renderers with no shotFn and no fallback
// file. Without a slug that is a silent gap: the reel advances its clock over a span it draws
// nothing into, and the single-shot endpoint has no composition to build.
const board = defineAnimatic(
  testDirection({ fps: 24, size: { megapixels: 0.24576, delivery: { width: 640, height: 384 } } }),
  {
    timeline: () =>
      animaticTimeline([
        shot("01", {
          duration: 4,
          build: () => {
            const first = asset("first", imageComfy, { prompt: "a wide establishing frame" });
            return (
              <Composition>
                <Panel src={first} {...moves} />
              </Composition>
            );
          },
        }),
        asideShot("op", { duration: 90, label: "OP" }),
      ]),
  },
);

describe("an aside on the board", () => {
  it("fills its span with a labelled slug in the reel", async () => {
    const { html } = await buildFullCompositionHtml({
      video: board,
      manager,
      assetBaseUrl: "",
      allowNotReady: true,
    });
    expect(html).toContain("OP");
    expect(html).toContain("90s");
  });

  it("builds on its own, rather than failing for want of a composition", async () => {
    const { html } = await buildShotCompositionHtml({
      video: board,
      manager,
      shotId: "op",
      assetBaseUrl: "",
      allowNotReady: true,
    });
    expect(html).toContain("OP");
  });
});
