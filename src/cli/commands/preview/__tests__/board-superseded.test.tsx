import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  boardCompositionSuperseded,
  materializeCompositionVariant,
} from "../../../../core/composition-resource.js";
import { Audio, Composition, Image } from "../../../../core/dsl/composition/index.js";
import { defineComfyAsset } from "../../../../core/dsl/comfy-asset.js";
import { asset, defineAnimatic, defineDirection, defineVideo } from "../../../../core/dsl/index.js";
import { StateManager } from "../../../../core/state/index.js";
import type { StageDefinition } from "../../../../core/types/index.js";
import { directionDefaults } from "../../../../core/__tests__/helpers/direction.js";
import { buildAssetStatus, needsReviewItems } from "../../../asset-status.js";
import { handleGetReelState } from "../reel-review.js";

const voice = defineComfyAsset({
  workflow: "voice.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const still = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ kind: "graphic", id: "01", role: "hero", action: "the title card", duration: 2 }],
  },
});

const Card = ({ size }: { size: number }) => (
  <div id="card" style={{ fontSize: `${size}vmax` }}>
    konte
  </div>
);

const board = (size: number, opts: { line?: boolean; overlay?: boolean; logo?: boolean } = {}) =>
  defineAnimatic(direction, {
    timeline: ({ graphicShot }) => {
      const logo = opts.logo ? asset("logo", still, { prompt: "a logo" }) : null;
      return {
        shots: graphicShot("01", () => (
          <Composition>
            <Card size={size} />
            {logo ? <Image src={logo} /> : null}
            {opts.line ? <Audio src={asset("line", voice, { text: "hello" })} /> : null}
          </Composition>
        )),
        ...(opts.overlay
          ? {
              overlay: () => (
                <Composition>
                  <div id="bug">konte</div>
                </Composition>
              ),
            }
          : {}),
      };
    },
  });

const cut = (size: number) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => ({
      shots: graphicShot("01", () => (
        <Composition>
          <Card size={size} />
        </Composition>
      )),
    }),
  });

const pendingCut = () =>
  defineVideo(direction, {
    timeline: ({ pendingShot }) => ({ shots: pendingShot("01") }),
  });

const BOARD = "animatic:shot.01#composition";
const CUT = "video:shot.01#composition";

let dir: string;
let manager: StateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-board-superseded-"));
  manager = await StateManager.init(dir);
});

function acceptTake(address: string, name: string): void {
  const id = manager.reserveVariantId(address);
  const take = manager.getAssetState(address).variants![id]!;
  take.file = `assets/${name}`;
  take.outputHash = `out-${id}`;
  manager.setAccepted(address, id);
}

async function acceptComposition(def: StageDefinition, address: string): Promise<void> {
  const variantId = await materializeCompositionVariant({ manager, video: def, shotId: "01" });
  manager.setAccepted(address, variantId!);
  await manager.save();
}

async function boardReel(animatic: StageDefinition, video: StageDefinition | null) {
  const res = await handleGetReelState(dir, animatic, "/assets", null, null, null, null, video);
  return (await res.json()) as {
    shots: { needsVerdict: boolean; compositionNeedsReview: boolean }[];
    overlay: { offered: boolean } | null;
  };
}

async function boardShot(animatic: StageDefinition, video: StageDefinition | null) {
  return (await boardReel(animatic, video)).shots[0]!;
}

async function needsReview(animatic: StageDefinition, video: StageDefinition) {
  const { report } = await buildAssetStatus({
    videoRoot: dir,
    manager: await StateManager.load(dir),
    video: video as never,
    animatic: animatic as never,
    reference: null,
  });
  return {
    needsReview: needsReviewItems(report).map((i) => i.address),
    board: report.infos.find((i) => i.address === BOARD)!,
  };
}

describe("a graphic shot's board composition once the video develops the shot", () => {
  it("is no review work before the video's first review", async () => {
    await acceptComposition(board(4), BOARD);

    const status = await needsReview(board(6), cut(6));
    expect(status.needsReview).toEqual([CUT]);
    expect(status.board.reviewTarget).toBe(false);
    expect(status.board.staleAcceptStands).toBe(true);
    expect(await boardShot(board(6), cut(6))).toMatchObject({
      needsVerdict: false,
      compositionNeedsReview: false,
    });
  });

  it("stays no review work after the video's accept goes stale", async () => {
    await acceptComposition(board(4), BOARD);
    await acceptComposition(cut(4), CUT);

    expect((await needsReview(board(6), cut(6))).needsReview).toEqual([CUT]);
  });

  it("is review work on its first review", async () => {
    expect((await needsReview(board(6), cut(6))).needsReview).toContain(BOARD);
    expect((await boardShot(board(6), cut(6))).needsVerdict).toBe(true);
  });

  it("is review work once a take it draws moves", async () => {
    acceptTake("animatic:timeline.logo", "logo-1.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    acceptTake("animatic:timeline.logo", "logo-2.png");
    await manager.save();

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toContain(BOARD);
    expect((await boardShot(board(6, { logo: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("is review work once it draws a new take", async () => {
    await acceptComposition(board(4), BOARD);
    const id = manager.reserveVariantId("animatic:timeline.logo");
    const logo = manager.getAssetState("animatic:timeline.logo").variants![id]!;
    logo.file = "assets/logo.png";
    logo.outputHash = "out-logo";
    await manager.save();

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toContain(BOARD);
    expect((await boardShot(board(6, { logo: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("is review work while the video shot is pending", async () => {
    await acceptComposition(board(4), BOARD);

    expect((await needsReview(board(6), pendingCut())).needsReview).toContain(BOARD);
    expect(await boardShot(board(6), pendingCut())).toMatchObject({
      needsVerdict: true,
      compositionNeedsReview: true,
    });
  });

  it("keeps the shot's own audio on the board's review", async () => {
    acceptTake("animatic:shot.01.line", "line.wav");
    await acceptComposition(board(4, { line: true }), BOARD);

    const status = await needsReview(board(6, { line: true }), cut(6));
    expect(status.needsReview).toEqual(["animatic:shot.01#stem", CUT]);
    expect((await boardShot(board(6, { line: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("leaves the board's overlay to be reviewed on its own", async () => {
    await acceptComposition(board(4, { overlay: true }), BOARD);

    const status = await needsReview(board(6, { overlay: true }), cut(6));
    expect(status.needsReview).toContain("animatic:timeline#overlay");
    expect((await boardReel(board(6, { overlay: true }), cut(6))).overlay?.offered).toBe(true);
  });

  it("is never claimed for the video's own composition or without the video", () => {
    expect(boardCompositionSuperseded(manager, board(4), null, BOARD)).toBe(false);
    expect(boardCompositionSuperseded(manager, board(4), cut(4), CUT)).toBe(false);
  });
});
