import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleGetDirectionState } from "../direction-review.js";
import { loadDirectionIfPresent } from "../../../load-definition.js";
import type { DirectionPreviewState } from "../../../../pages/preview/types.js";
import { ctx, initWorkspace, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const NOVEL_MD = `# 第一章

澪は駅のホームに立っていた。

「切符がない」と澪は言った。

駅長が首を振った。

# 第二章

蓮は改札で待っていた。
`;

const DIGEST_C1 = `import { defineSourceChunk } from "konte";
export default defineSourceChunk({
  chunk: "c1",
  scenes: {
    "c1.s1": { at: "c1.p1-p2", place: "駅のホーム", present: ["澪"], change: "澪が切符を失くす" },
    "c1.s2": { at: "c1.p3", place: "駅のホーム", present: ["駅長"], change: "駅長が断る" },
  },
  looks: [{ of: "澪", at: "c1.p1", text: "濡れた前髪" }],
});
`;

function directionTs(withSource: boolean): string {
  return `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test"${withSource ? ', source: { span: "c1-c2", keep: ["切符"] }' : ""} },
  characters: { mio: { name: "澪", promptDepiction: "girl", description: "a girl" } },
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { mark: { name: "the mark", promptDepiction: "mark", description: "a mark" } } } },
  setups: {
    front: { name: "the front angle", description: "straight on", location: "studio", framing: "medium", view: "front", holds: ["mark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "ja" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", lineup: ["mio"], duration: 5 }],
  },
});
`;
}

async function stateOf(withSource: boolean): Promise<DirectionPreviewState> {
  const { video } = await initWorkspace(path.join(ctx.dir, "testproject"));
  const source = path.join(video, "source");
  await fs.mkdir(path.join(source, "digest"), { recursive: true });
  await fs.writeFile(path.join(source, "novel.md"), NOVEL_MD);
  await fs.writeFile(path.join(source, "digest", "c01.ts"), DIGEST_C1);
  await fs.writeFile(path.join(video, "direction.ts"), directionTs(withSource));
  const direction = (await loadDirectionIfPresent(video))!;
  const res = await handleGetDirectionState(video, direction, null, null);
  return (await res.json()) as DirectionPreviewState;
}

describe("direction review of a source", () => {
  it("shows the source with its span by its chapters", async () => {
    const state = await stateOf(true);
    const brief = state.brief.find((f) => f.field === "source");
    expect(brief).toMatchObject({
      address: "direction:brief.source",
      source: { span: "第一章 – 第二章", keep: ["切符"], drop: [] },
    });
  });

  it("shows no source row on a direction with none", async () => {
    const state = await stateOf(false);
    expect(state.brief.some((f) => f.field === "source")).toBe(false);
  });
});
