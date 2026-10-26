import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { remakeSettledLeaves } from "../../../../core/board-leaves.js";
import { compositionPictureNodes } from "../../../../core/composition-builder.js";
import {
  leafSettledAcross,
  leafSignedOff,
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

const Caption = () => <div id="caption">hello</div>;

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

const cut = (size: number, opts: { caption?: boolean } = {}) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => ({
      shots: graphicShot("01", () => (
        <Composition>
          <Card size={size} />
          {opts.caption ? <Caption /> : null}
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
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-settled-across-"));
  manager = await StateManager.init(dir);
});

function acceptTake(address: string, name: string): string {
  const id = manager.reserveVariantId(address);
  const take = manager.getAssetState(address).variants![id]!;
  take.file = `assets/${name}`;
  take.outputHash = `out-${id}`;
  manager.setAccepted(address, id);
  return id;
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

async function cutShot(animatic: StageDefinition, video: StageDefinition) {
  const res = await handleGetReelState(dir, video, "/assets", null, null, animatic as never);
  return ((await res.json()) as { shots: { needsVerdict: boolean }[] }).shots[0]!;
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

describe("a graphic shot's composition drawn on both stages", () => {
  it("asks for a verdict on both pages after an edit to what they share", async () => {
    await acceptComposition(board(4), BOARD);
    await acceptComposition(cut(4), CUT);

    expect((await boardShot(board(6), cut(6))).needsVerdict).toBe(true);
    expect((await cutShot(board(6), cut(6))).needsVerdict).toBe(true);
  });

  it("routes the review to the video alone while the video's picture holds the board's", async () => {
    await acceptComposition(board(4), BOARD);
    await acceptComposition(cut(4, { caption: true }), CUT);

    const status = await needsReview(board(6), cut(6, { caption: true }));
    expect(status.needsReview).toEqual([CUT]);
    expect(status.board.reviewTarget).toBe(false);
  });

  it("routes the review to both while the video's picture does not hold the board's", async () => {
    acceptTake("animatic:timeline.logo", "logo.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(4), CUT);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([BOARD, CUT]);
  });

  it("routes the review to the board while a take only the board draws moved", async () => {
    acceptTake("animatic:shot.01.line", "line-1.wav");
    await acceptComposition(board(4, { line: true }), BOARD);
    await acceptComposition(cut(4), CUT);
    acceptTake("animatic:shot.01.line", "line-2.wav");
    await manager.save();

    expect((await needsReview(board(6, { line: true }), cut(6))).needsReview).toContain(BOARD);
  });

  it("is settled on the board by the video's accept when the video's picture holds the board's", async () => {
    await acceptComposition(board(4), BOARD);
    await acceptComposition(cut(6, { caption: true }), CUT);

    const status = await needsReview(board(6), cut(6, { caption: true }));
    expect(status.needsReview).toEqual([]);
    expect(status.board.staleAcceptStands).toBe(true);
    expect(await boardShot(board(6), cut(6, { caption: true }))).toMatchObject({
      needsVerdict: false,
      compositionNeedsReview: false,
    });
  });

  it("keeps the video's review open after the board's accept when the video's picture holds more", async () => {
    await acceptComposition(cut(4, { caption: true }), CUT);
    await acceptComposition(board(6), BOARD);

    expect((await needsReview(board(6), cut(6, { caption: true }))).needsReview).toEqual([CUT]);
    expect((await cutShot(board(6), cut(6, { caption: true }))).needsVerdict).toBe(true);
  });

  it("is settled on the video by the board's accept when the pictures match", async () => {
    await acceptComposition(cut(4), CUT);
    await acceptComposition(board(6), BOARD);

    expect((await needsReview(board(6), cut(6))).needsReview).toEqual([]);
    expect((await cutShot(board(6), cut(6))).needsVerdict).toBe(false);
  });

  it("is settled on the video by the board's accept when the board's picture holds the video's", async () => {
    acceptTake("animatic:timeline.logo", "logo.png");
    await acceptComposition(cut(4), CUT);
    await acceptComposition(board(6, { logo: true }), BOARD);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([]);
  });

  it("is not settled by a picture whose own style restyles what the two share", async () => {
    const hiding = defineAnimatic(direction, {
      timeline: ({ graphicShot }) => ({
        shots: graphicShot("01", () => (
          <Composition>
            <Card size={6} />
            <style>{"#card { display: none }"}</style>
          </Composition>
        )),
      }),
    });
    await acceptComposition(cut(4), CUT);
    await acceptComposition(hiding, BOARD);

    expect(leafSettledAcross(manager, cut(6), hiding, CUT)).toBe(false);
    expect((await needsReview(hiding, cut(6))).needsReview).toContain(CUT);
  });

  it("is review work on the board when the video's picture does not hold it", async () => {
    acceptTake("animatic:timeline.logo", "logo.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(6), CUT);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([BOARD]);
    expect((await boardShot(board(6, { logo: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("re-makes and accepts the composition the other stage's accept settled", async () => {
    await acceptComposition(cut(4), CUT);
    await acceptComposition(board(6), BOARD);

    const remade = await remakeSettledLeaves({
      videoRoot: dir,
      stage: cut(6),
      counterpart: board(6),
      include: "compositions",
    });

    expect(remade).toEqual({ accepted: [{ shotId: "01", address: CUT }], failed: [] });
    expect(leafSignedOff(await StateManager.load(dir), cut(6), CUT)).toBe(true);
  });

  it("is review work on its first review over a take only the board draws", async () => {
    acceptTake("animatic:shot.01.line", "line.wav");
    await manager.save();

    expect((await needsReview(board(6, { line: true }), cut(6))).needsReview).toContain(BOARD);
    expect((await boardShot(board(6, { line: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("is review work on the board once a take only it draws moves", async () => {
    acceptTake("animatic:timeline.logo", "logo-1.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(6), CUT);
    acceptTake("animatic:timeline.logo", "logo-2.png");
    await manager.save();

    expect((await needsReview(board(4, { logo: true }), cut(6))).needsReview).toContain(BOARD);
  });

  it("is review work on the board while the video shot is pending", async () => {
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
    await acceptComposition(cut(6), CUT);

    const status = await needsReview(board(6, { line: true }), cut(6));
    expect(status.needsReview).toEqual(["animatic:shot.01#stem"]);
    expect((await boardShot(board(6, { line: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("leaves the board's overlay to be reviewed on its own", async () => {
    await acceptComposition(board(4, { overlay: true }), BOARD);
    await acceptComposition(cut(6), CUT);

    const status = await needsReview(board(6, { overlay: true }), cut(6));
    expect(status.needsReview).toContain("animatic:timeline#overlay");
    expect((await boardReel(board(6, { overlay: true }), cut(6))).overlay?.offered).toBe(true);
  });

  it("is never claimed without the other stage, or for an address of another stage", () => {
    expect(leafSettledAcross(manager, board(4), null, BOARD)).toBe(false);
    expect(leafSettledAcross(manager, board(4), cut(4), CUT)).toBe(false);
  });
});

describe("a graphic shot's composition over a take both stages draw", () => {
  const SCREEN = "animatic:shot.01.screen";
  const screenBoard = (size: number) =>
    defineAnimatic(direction, {
      timeline: ({ graphicShot }) => ({
        shots: graphicShot("01", () => (
          <Composition>
            <Card size={size} />
            <Image src={asset("screen", still, { prompt: "a screen" })} />
          </Composition>
        )),
      }),
    });
  const screenCut = (size: number) => {
    const animatic = screenBoard(size);
    return defineVideo(direction, {
      timeline: ({ graphicShot }) => ({
        shots: graphicShot("01", () => (
          <Composition>
            <Card size={size} />
            <Image src={animatic.shot("01").image("screen")} />
          </Composition>
        )),
      }),
    });
  };

  it("is settled on the board once the video's signed-off composition drew the moved take", async () => {
    const first = acceptTake(SCREEN, "screen-1.png");
    await acceptComposition(screenBoard(4), BOARD);
    manager.setAccepted(SCREEN, acceptTake(SCREEN, "screen-2.png"), { dismiss: [first] });
    await acceptComposition(screenCut(6), CUT);

    expect((await needsReview(screenBoard(6), screenCut(6))).needsReview).toEqual([]);
  });

  it("is review work on both pages, routed to the video, while the video drew an older take", async () => {
    acceptTake(SCREEN, "screen-1.png");
    await acceptComposition(screenBoard(4), BOARD);
    await acceptComposition(screenCut(6), CUT);
    acceptTake(SCREEN, "screen-2.png");
    await manager.save();

    const status = await needsReview(screenBoard(6), screenCut(6));
    expect(status.needsReview).toContain(CUT);
    expect(status.needsReview).not.toContain(BOARD);
    expect((await boardShot(screenBoard(6), screenCut(6))).needsVerdict).toBe(true);
  });
});

describe("compositionPictureNodes", () => {
  it("splits the picture into its top-level nodes, reading a script's body as text", () => {
    const def = defineVideo(direction, {
      timeline: ({ graphicShot }) => ({
        shots: graphicShot("01", () => (
          <Composition>
            <style>{".a > b { color: red }"}</style>
            <div id="a">
              <img src="x.png" alt="" />
              <div>inner</div>
            </div>
            <script dangerouslySetInnerHTML={{ __html: 'host.innerHTML = "<div>";' }} />
            <Caption />
          </Composition>
        )),
      }),
    });

    expect(compositionPictureNodes(def, "01")).toEqual([
      "<style>.a > b { color: red }</style>",
      '<div id="a"><img src="x.png" alt="" /><div>inner</div></div>',
      '<script>host.innerHTML = "<div>";</script>',
      '<div id="caption">hello</div>',
    ]);
  });
});
