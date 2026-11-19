import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleDirectionSubmit } from "../direction-review.js";
import {
  loadDirectionIfPresent,
  loadStageDefinitions,
} from "../../../../core/stage-definitions.js";
import { directionHash } from "../../../../core/direction-hash.js";
import { StateManager } from "../../../../core/state/index.js";
import type { Direction } from "../../../../core/dsl/direction.js";
import { ctx, initWorkspace, useTempWorkspace } from "../../../__tests__/cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

const DIRECTION_TS = `import { defineDirection } from "konte";

export default defineDirection({
  brief: { logline: "test" },
  characters: {},
  props: { cup: { name: "the cup", description: "a chipped cup", promptDepiction: "cup" } },
  locations: { studio: { name: "the studio", description: "a plain studio", landmarks: { studioMark: { name: "the mark", promptDepiction: "mark", description: "a mark only this place has" } }, views: { front: { holds: ["studioMark"] } } } },
  setups: {
    front: { name: "the front angle", description: "straight on, eye level", location: "studio", framing: "medium", view: "front", holds: ["studioMark"] },
  },
  policy: { format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } }, lang: "en" },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ id: "01", role: "hero", action: "test shot", setup: "front", lineup: [], props: [], duration: 5 }],
  },
});
`;

const submit = async (videoRoot: string, direction: Direction, body: Record<string, unknown>) =>
  handleDirectionSubmit(
    videoRoot,
    null,
    direction,
    await loadStageDefinitions(videoRoot, { tolerant: true }),
    new Request("http://127.0.0.1/api/direction/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addedFeedback: [], feedbackPatches: [], ...body }),
    }),
  );

describe("direction submit", () => {
  it("drops only the accept of a section a finding holds, and saves the rest of the review", async () => {
    const videoRoot = (await initWorkspace(path.join(ctx.dir, "testproject"))).video;
    await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
    const direction = (await loadDirectionIfPresent(videoRoot))!;

    const res = await submit(videoRoot, direction, {
      accept: true,
      reviewedHash: directionHash(direction),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      saved: boolean;
      filePath: string;
      skippedDecisions: Array<{ address: string; reason: string }>;
    };
    expect(payload.saved).toBe(true);
    expect(payload.skippedDecisions).toEqual([
      { address: "direction:props", reason: expect.stringContaining("[unused-prop_cup]") },
    ]);
    const record = JSON.parse(await fs.readFile(payload.filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(record.directionDecisions).toMatchObject({ policy: "accepted", shots: "accepted" });
    expect(record.directionDecisions).not.toHaveProperty("props");
    expect(record.directionDecisions).not.toHaveProperty("brief");

    const acceptance = (await StateManager.load(videoRoot)).getDirectionAcceptance();
    const accepted = Object.keys(acceptance?.parts ?? {});
    expect(accepted).toContain("direction:policy.format");
    expect(accepted).not.toContain("direction:props.cup");
  });

  it("records no withdrawal on a direction that held no sign-off", async () => {
    const videoRoot = (await initWorkspace(path.join(ctx.dir, "testproject"))).video;
    await fs.writeFile(path.join(videoRoot, "direction.ts"), DIRECTION_TS);
    const direction = (await loadDirectionIfPresent(videoRoot))!;

    const res = await submit(videoRoot, direction, { overallComment: "not yet", accept: false });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { filePath: string };
    const record = JSON.parse(await fs.readFile(payload.filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(record.directionDecisions).toBeUndefined();
    expect((await StateManager.load(videoRoot)).getDirectionAcceptance()?.parts ?? {}).toEqual({});
  });
  it("offers no box a stale waiver alone holds open", async () => {
    const videoRoot = (await initWorkspace(path.join(ctx.dir, "testproject"))).video;
    await fs.writeFile(
      path.join(videoRoot, "direction.ts"),
      DIRECTION_TS.replace(
        "  policy:",
        '  waivers: { "song-overrun": "the song runs long" },\n  policy:',
      ),
    );
    const direction = (await loadDirectionIfPresent(videoRoot))!;

    const res = await submit(videoRoot, direction, {
      accept: true,
      reviewedHash: directionHash(direction),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { filePath: string };
    const record = JSON.parse(await fs.readFile(payload.filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(record.directionDecisions).toMatchObject({ policy: "accepted" });
    expect(record.directionDecisions).not.toHaveProperty("waivers");
  });
});
