import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { remakeSettledLeaves } from "../../../../core/board-leaves.js";
import { compositionPictureNodes } from "../../../../core/composition-builder.js";
import {
  boardStemAwaitsVideo,
  commitShotStem,
  leafSettledAcross,
  leafSignedOff,
  materializeCompositionVariant,
  prepareShotStem,
} from "../../../../core/composition-resource.js";
import { Audio, Composition, Image, Panel } from "../../../../core/dsl/composition/index.js";
import { defineComfyAsset } from "../../../../core/dsl/comfy-asset.js";
import {
  adapters,
  asset,
  defineAnimatic,
  defineDirection,
  defineVideo,
} from "../../../../core/dsl/index.js";
import { applyResolutionDefinitions } from "../../../../core/definition-hashes.js";
import { StateManager } from "../../../../core/state/index.js";
import type { StageDefinition, VideoDefinition } from "../../../../core/types/index.js";
import { directionDefaults } from "../../../../core/__tests__/helpers/direction.js";
import { writeSilentWav } from "../../../../core/__tests__/helpers/wav.js";
import { buildAssetStatus } from "../../../../core/status-report.js";
import { handleGetReelState } from "../reel-review.js";
import { ASSET_SITES } from "../../../../core/dsl/adapter.js";

const voice = defineComfyAsset({
  allowedIn: ASSET_SITES,
  workflow: "voice.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const still = defineComfyAsset({
  allowedIn: ASSET_SITES,
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

const cut = (size: number, opts: { caption?: boolean; logo?: boolean } = {}) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => {
      const logo = opts.logo ? asset("logo", still, { prompt: "a logo" }) : null;
      return {
        shots: graphicShot("01", () => (
          <Composition>
            <Card size={size} />
            {logo ? <Image src={logo} /> : null}
            {opts.caption ? <Caption /> : null}
          </Composition>
        )),
      };
    },
  });

const heard = (
  animatic: ReturnType<typeof board>,
  opts: { volume?: number; twice?: boolean } = {},
) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => ({
      shots: graphicShot("01", () => (
        <Composition>
          <Card size={6} />
          <Audio src={animatic.shot("01").stem} volume={opts.volume} />
          {opts.twice ? <Audio src={animatic.shot("01").stem} /> : null}
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

function acceptVariant(address: string, name: string, outputHash?: string): string {
  const id = manager.reserveVariantId(address);
  const variant = manager.getAssetState(address).variants![id]!;
  variant.file = `assets/${name}`;
  variant.outputHash = outputHash ?? `out-${id}`;
  manager.setAccepted(address, id);
  return id;
}

async function acceptStem(def: StageDefinition, address: string): Promise<void> {
  const prepared = await prepareShotStem({ manager, video: def, address });
  const variantId = await commitShotStem({ manager, video: def, address, prepared: prepared! });
  manager.setAccepted(address, variantId!);
  await manager.save();
}

async function acceptComposition(def: StageDefinition, address: string): Promise<void> {
  const variantId = await materializeCompositionVariant({ manager, video: def, shotId: "01" });
  manager.setAccepted(address, variantId!);
  await manager.save();
}

// What a command registers before it resolves anything: the definitions on disk.
async function onDisk(animatic: StageDefinition, video: StageDefinition | null): Promise<void> {
  await applyResolutionDefinitions({
    videoRoot: dir,
    definitions: { reference: null, animatic: animatic as never, video: video as never },
    patchHashes: new Map(),
  });
}

async function boardReel(animatic: StageDefinition, video: StageDefinition | null) {
  await onDisk(animatic, video);
  const res = await handleGetReelState(
    {
      videoRoot: dir,
      handoff: null,
      direction: null,
      animatic: null,
      reference: null,
      stage: "animatic",
      video: video as VideoDefinition | null,
    },
    animatic,
    "/assets",
  );
  return (await res.json()) as {
    shots: { needsVerdict: boolean; compositionNeedsReview: boolean }[];
    overlay: { offered: boolean } | null;
  };
}

async function boardShot(animatic: StageDefinition, video: StageDefinition | null) {
  return (await boardReel(animatic, video)).shots[0]!;
}

async function cutShot(animatic: StageDefinition, video: StageDefinition) {
  await onDisk(animatic, video);
  const res = await handleGetReelState(
    {
      videoRoot: dir,
      handoff: null,
      direction: null,
      animatic: animatic as never,
      reference: null,
      stage: "video",
      video: null,
    },
    video,
    "/assets",
  );
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
    needsReview: report.sections.needsReview.map((i) => i.address),
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
    acceptVariant("animatic:timeline.logo", "logo.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(4), CUT);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([BOARD, CUT]);
  });

  it("routes the review to the board while a take only the board draws moved", async () => {
    acceptVariant("animatic:shot.01.line", "line-1.wav");
    await acceptComposition(board(4, { line: true }), BOARD);
    await acceptComposition(cut(4), CUT);
    acceptVariant("animatic:shot.01.line", "line-2.wav");
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
    acceptVariant("animatic:timeline.logo", "logo.png");
    await acceptComposition(cut(4), CUT);
    await acceptComposition(board(6, { logo: true }), BOARD);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([]);
  });

  it("is settled on the video by the board's accept when each stage's own asset holds the same file", async () => {
    acceptVariant("animatic:timeline.logo", "logo.png", "logo-bytes");
    acceptVariant("video:timeline.logo", "logo.png", "logo-bytes");
    await acceptComposition(cut(4, { logo: true }), CUT);
    await acceptComposition(board(6, { logo: true }), BOARD);

    expect(
      (await needsReview(board(6, { logo: true }), cut(6, { logo: true }))).needsReview,
    ).toEqual([]);
  });

  it("routes the review to the video alone when each stage's own asset holds the same file", async () => {
    acceptVariant("animatic:timeline.logo", "logo.png", "logo-bytes");
    acceptVariant("video:timeline.logo", "logo.png", "logo-bytes");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(4, { logo: true, caption: true }), CUT);

    const status = await needsReview(
      board(6, { logo: true }),
      cut(6, { logo: true, caption: true }),
    );
    expect(status.needsReview).toEqual([CUT]);
  });

  it("is not settled across when each stage's own asset holds a different file", async () => {
    acceptVariant("animatic:timeline.logo", "logo-a.png", "logo-a");
    acceptVariant("video:timeline.logo", "logo-b.png", "logo-b");
    await acceptComposition(cut(4, { logo: true }), CUT);
    await acceptComposition(board(6, { logo: true }), BOARD);

    expect(
      (await needsReview(board(6, { logo: true }), cut(6, { logo: true }))).needsReview,
    ).toEqual([CUT]);
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
    acceptVariant("animatic:timeline.logo", "logo.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(6), CUT);

    expect((await needsReview(board(6, { logo: true }), cut(6))).needsReview).toEqual([BOARD]);
    expect((await boardShot(board(6, { logo: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("re-makes and accepts the composition the other stage's accept settled", async () => {
    await acceptComposition(cut(4), CUT);
    await acceptComposition(board(6), BOARD);

    await onDisk(board(6), cut(6));
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
    acceptVariant("animatic:shot.01.line", "line.wav");
    await manager.save();

    expect((await needsReview(board(6, { line: true }), cut(6))).needsReview).toContain(BOARD);
    expect((await boardShot(board(6, { line: true }), cut(6))).needsVerdict).toBe(true);
  });

  it("is review work on the board once a take only it draws moves", async () => {
    acceptVariant("animatic:timeline.logo", "logo-1.png");
    await acceptComposition(board(4, { logo: true }), BOARD);
    await acceptComposition(cut(6), CUT);
    acceptVariant("animatic:timeline.logo", "logo-2.png");
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
    acceptVariant("animatic:shot.01.line", "line.wav");
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
    const first = acceptVariant(SCREEN, "screen-1.png");
    await acceptComposition(screenBoard(4), BOARD);
    manager.setAccepted(SCREEN, acceptVariant(SCREEN, "screen-2.png"), { dismiss: [first] });
    await acceptComposition(screenCut(6), CUT);

    expect((await needsReview(screenBoard(6), screenCut(6))).needsReview).toEqual([]);
  });

  it("is review work on both pages, routed to the video, while the video drew an older take", async () => {
    acceptVariant(SCREEN, "screen-1.png");
    await acceptComposition(screenBoard(4), BOARD);
    await acceptComposition(screenCut(6), CUT);
    acceptVariant(SCREEN, "screen-2.png");
    await manager.save();

    const status = await needsReview(screenBoard(6), screenCut(6));
    expect(status.needsReview).toContain(CUT);
    expect(status.needsReview).not.toContain(BOARD);
    expect((await boardShot(screenBoard(6), screenCut(6))).needsVerdict).toBe(true);
  });
});

describe("a narrative shot both stages build from files alone", () => {
  const STILL = "animatic:shot.01.still";
  const narrative = defineDirection({
    ...directionDefaults,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "hero",
          action: "the screen lights up",
          setup: "front",
          lineup: [],
          duration: 2,
        },
      ],
    },
  });
  const fileBoard = (size: number, lineVolume?: number, extra?: React.ReactNode) =>
    defineAnimatic(narrative, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel
              src={asset("still", adapters.imageFile, { path: "assets/files/still.png" })}
              blocking="the screen lights up"
              camera="fixed"
            />
            <Card size={size} />
            {extra}
            {lineVolume === undefined ? null : (
              <Audio src={asset("line", voice, { text: "hello" })} volume={lineVolume} />
            )}
          </Composition>
        )),
      }),
    });
  const fileCut = (size: number, lineVolume?: number, extra?: React.ReactNode) => {
    const animatic = fileBoard(size, lineVolume);
    return defineVideo(narrative, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Image src={animatic.shot("01").image("still")} fill />
            <Card size={size} />
            {extra}
            {lineVolume === undefined ? null : <Audio src={animatic.shot("01").stem} />}
          </Composition>
        )),
      }),
    });
  };

  beforeEach(() => {
    acceptVariant(STILL, "files/still.png");
  });

  it("is settled on the board by the video's accept of its composition", async () => {
    await acceptComposition(fileBoard(4), BOARD);
    await acceptComposition(fileCut(6), CUT);

    expect((await needsReview(fileBoard(6), fileCut(6))).needsReview).toEqual([]);
    expect(await boardShot(fileBoard(6), fileCut(6))).toMatchObject({
      needsVerdict: false,
      compositionNeedsReview: false,
    });
  });

  it.each([
    { reader: "a style", mark: <style>{"[data-konte-panel] { opacity: 0 }"}</style> },
    { reader: "an upper-case style", mark: <style>{"[DATA-KONTE-PANEL] { opacity: 0 }"}</style> },
    {
      reader: "a script through the dataset",
      mark: <script dangerouslySetInnerHTML={{ __html: "img.dataset.kontePanel && hide(img);" }} />,
    },
  ])("is not settled across when $reader reads the panel's mark", async ({ mark }) => {
    await acceptComposition(fileBoard(6, undefined, mark), BOARD);

    expect(
      leafSettledAcross(manager, fileCut(6, undefined, mark), fileBoard(6, undefined, mark), CUT),
    ).toBe(false);
  });

  it("is not settled across by a script that differs only in the panel's mark", async () => {
    const label = (color: string) => (
      <script
        dangerouslySetInnerHTML={{ __html: `label.innerHTML = ' data-konte-panel="${color}"';` }}
      />
    );
    await acceptComposition(fileBoard(6, undefined, label("red")), BOARD);

    expect(
      leafSettledAcross(
        manager,
        fileCut(6, undefined, label("blue")),
        fileBoard(6, undefined, label("red")),
        CUT,
      ),
    ).toBe(false);
  });

  it("routes the review to the video alone until the video signs the shot off", async () => {
    await acceptComposition(fileBoard(4), BOARD);

    expect((await needsReview(fileBoard(6), fileCut(6))).needsReview).toEqual([CUT]);
  });

  it("is review work on the board after an edit the video's picture does not draw", async () => {
    await acceptComposition(fileBoard(4), BOARD);
    await acceptComposition(fileCut(6), CUT);

    expect(leafSettledAcross(manager, fileBoard(8), fileCut(6), BOARD)).toBe(false);
    expect((await needsReview(fileBoard(8), fileCut(6))).needsReview).toContain(BOARD);
  });

  it("re-makes and accepts the board composition the video's accept settled", async () => {
    await acceptComposition(fileBoard(4), BOARD);
    await acceptComposition(fileCut(6), CUT);

    await onDisk(fileBoard(6), fileCut(6));
    const remade = await remakeSettledLeaves({
      videoRoot: dir,
      stage: fileBoard(6),
      counterpart: fileCut(6),
      include: "compositions",
    });

    expect(remade).toEqual({ accepted: [{ shotId: "01", address: BOARD }], failed: [] });
    expect(leafSignedOff(await StateManager.load(dir), fileBoard(6), BOARD)).toBe(true);
  });

  it("offers a mix edited under the video's composition accept on both reviews", async () => {
    const BOARD_STEM = "animatic:shot.01#stem";
    await writeSilentWav(path.join(dir, "assets", "line.wav"));
    acceptVariant("animatic:shot.01.line", "line.wav");
    await acceptStem(fileBoard(6, 1), BOARD_STEM);
    await acceptComposition(fileBoard(6, 1), BOARD);
    await acceptComposition(fileCut(6, 1), CUT);

    await onDisk(fileBoard(6, 0.5), fileCut(6, 0.5));
    expect(leafSettledAcross(manager, fileBoard(6, 0.5), fileCut(6, 0.5), BOARD_STEM)).toBe(false);
    expect(boardStemAwaitsVideo(manager, fileBoard(6, 0.5), fileCut(6, 0.5), BOARD_STEM)).toBe(
      true,
    );
    expect((await boardShot(fileBoard(6, 0.5), fileCut(6, 0.5))).needsVerdict).toBe(true);
    expect((await needsReview(fileBoard(6, 0.5), fileCut(6, 0.5))).needsReview).toContain(
      "video:shot.01#stem",
    );
  });

  it("keeps a mix edited under a video shot that still has a take to spend on on the board's review", async () => {
    const BOARD_STEM = "animatic:shot.01#stem";
    await writeSilentWav(path.join(dir, "assets", "line.wav"));
    acceptVariant("animatic:shot.01.line", "line.wav");
    await acceptStem(fileBoard(6, 1), BOARD_STEM);
    const b = fileBoard(6, 0.5);
    const unspent = defineVideo(narrative, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Image src={asset("still", still, { prompt: "the screen" })} fill />
            <Audio src={b.shot("01").stem} />
          </Composition>
        )),
      }),
    });

    expect(boardStemAwaitsVideo(manager, b, unspent, BOARD_STEM)).toBe(false);
    expect((await needsReview(b, unspent)).needsReview).toContain(BOARD_STEM);
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

describe("a video shot's stem that plays its board shot's stem as mixed", () => {
  const BOARD_STEM = "animatic:shot.01#stem";
  const CUT_STEM = "video:shot.01#stem";

  beforeEach(async () => {
    await writeSilentWav(path.join(dir, "assets", "line.wav"));
    acceptVariant("animatic:shot.01.line", "line.wav");
    await acceptStem(board(6, { line: true }), BOARD_STEM);
  });

  it("is settled by the board stem's accept", async () => {
    const b = board(6, { line: true });

    expect(leafSettledAcross(manager, heard(b), b, CUT_STEM)).toBe(true);
    expect((await needsReview(b, heard(b))).needsReview).not.toContain(CUT_STEM);
  });

  it("is review work once the video sets its own level on it", async () => {
    const b = board(6, { line: true });

    expect(leafSettledAcross(manager, heard(b, { volume: 0.5 }), b, CUT_STEM)).toBe(false);
    expect((await needsReview(b, heard(b, { volume: 0.5 }))).needsReview).toContain(CUT_STEM);
  });

  it("is review work when it plays the board stem twice", async () => {
    const b = board(6, { line: true });

    expect(leafSettledAcross(manager, heard(b, { twice: true }), b, CUT_STEM)).toBe(false);
  });

  it("is review work while the board stem's accept does not stand", async () => {
    acceptVariant("animatic:shot.01.line", "line.wav");
    await manager.save();
    const b = board(6, { line: true });

    expect(leafSettledAcross(manager, heard(b), b, CUT_STEM)).toBe(false);
  });

  it("is re-made and accepted over the board stem the board's accept settled", async () => {
    const b = board(6, { line: true });

    const remade = await remakeSettledLeaves({
      videoRoot: dir,
      stage: heard(b),
      counterpart: b,
      include: "stems",
    });

    expect(remade).toEqual({ accepted: [{ shotId: "01", address: CUT_STEM }], failed: [] });
    expect(leafSignedOff(await StateManager.load(dir), heard(b), CUT_STEM)).toBe(true);
  });
});
