import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  Composition,
  Cutin,
  Image,
  Panel,
  Video,
  asset,
  defineAnimatic,
  defineDirection,
  defineReference,
  defineVideo,
} from "../dsl/index.js";
import {
  buildDependencyGraph,
  listBoardlessVideoShots,
  listPanelReferenceSlots,
  listShotContinuity,
  listVideoShotPins,
  shotLaneChains,
} from "../graph.js";
import { renderToHtml } from "../jsx-html.js";
import { directionDefaults } from "./helpers/direction.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test image adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    image1: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const motionComfy = defineComfyAsset({
  workflow: "motion.json",
  description: "test motion adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    startImage: { nodeId: "2", field: "image", type: "image", pin: "start" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A narrative shot, a UI screen with the presenter wiped in over it, and a bare UI screen.
const direction = defineDirection({
  ...directionDefaults,
  characters: {
    nazuna: { name: "Nazuna", promptDepiction: "girl in a maid apron", description: "presenter" },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "she sits", setup: "front", duration: 4, lineup: [] },
      {
        kind: "graphic",
        id: "02",
        role: "disruption",
        action: "the dashboard opens",
        duration: 4,
        cutin: { setup: "front", lineup: ["nazuna"] },
      },
      { kind: "graphic", id: "03", role: "pressure", action: "a toast pops", duration: 2 },
    ],
  },
});

const reference = defineReference(direction, () => ({
  nazuna: asset("nazuna", imageComfy, { prompt: "a girl in a maid apron" }),
}));
const REF = reference.nazuna;

const narrativeBoard = () => (
  <Composition>
    <Panel src={asset("first", imageComfy, { prompt: "a desk" })} />
  </Composition>
);

const wipeBoard = () => (
  <Composition>
    <Image src={asset("screen", imageComfy, { prompt: "a dashboard" })} fill />
    <Cutin at="bottom-right" size={0.25}>
      <Panel
        src={asset("presenter", imageComfy, { prompt: "a girl in a maid apron", image1: REF })}
      />
    </Cutin>
  </Composition>
);

const bareBoard = () => (
  <Composition>
    <div>toast</div>
  </Composition>
);

const animatic = () =>
  defineAnimatic(direction, {
    timeline: ({ shot }) => ({
      shots: shot("01", narrativeBoard)
        .nextGraphicShot("02", wipeBoard)
        .nextGraphicShot("03", bareBoard),
    }),
  });

describe("the graphic starters", () => {
  it("hands a graphic build its span, lines and cutin — and no frame of its own", () => {
    const seen: Record<string, unknown>[] = [];
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", (ctx) => {
          seen.push({ cutin: ctx.cutin });
          return narrativeBoard();
        })
          .nextGraphicShot("02", (ctx) => {
            seen.push({ ...ctx, shot: undefined, script: undefined });
            return wipeBoard();
          })
          .nextGraphicShot("03", bareBoard),
      }),
    });
    expect(seen).toEqual([
      { cutin: null },
      {
        duration: 4,
        cutin: {
          setup: "front",
          framing: "medium",
          location: "studio",
          lineup: ["nazuna"],
          lineupTo: null,
        },
        shot: undefined,
        script: undefined,
      },
    ]);
  });

  it("marks a graphic shot and records its cutin's keyframes in their own lane", () => {
    const board = animatic();
    const [first, wiped, bare] = board.shots;
    expect(first!.graphic).toBeUndefined();
    expect(wiped!.graphic).toBe(true);
    expect(wiped!.action).toBe("the dashboard opens");
    expect(wiped!.panels).toBeUndefined();
    expect(wiped!.cutin?.panels?.map((p) => [p.assetPath, p.start, p.duration])).toEqual([
      ["animatic:shot.02.presenter", 0, 4],
    ]);
    expect(wiped!.cutin?.refs).toEqual(["animatic:shot.02.presenter"]);
    expect(bare!.graphic).toBe(true);
    expect(bare!.cutin).toBeUndefined();

    expect(listPanelReferenceSlots(board)).toEqual([
      { shotId: "02", lane: "cutin", panel: "animatic:shot.02.presenter", slots: ["nazuna"] },
    ]);
    // A graphic shot's main frame has no keyframe, so it answers no seam; its wipe does.
    expect(listShotContinuity(board)).toEqual([
      {
        shotId: "01",
        lane: "main",
        firstPanel: "animatic:shot.01.first",
        lastPanel: "animatic:shot.01.first",
        carries: false,
        linked: [],
      },
      {
        shotId: "02",
        lane: "cutin",
        firstPanel: "animatic:shot.02.presenter",
        lastPanel: "animatic:shot.02.presenter",
        carries: false,
        linked: [],
      },
    ]);
  });

  it("reaches a cutin keyframe from the video by name", () => {
    const board = animatic();
    const video = defineVideo(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video
              src={asset("motion", motionComfy, {
                prompt: "x",
                startImage: board.shot("01").image("first"),
              })}
            />
          </Composition>
        ))
          .nextGraphicShot("02", () => (
            <Composition>
              <Cutin>
                <Video
                  src={asset("presenter", motionComfy, {
                    prompt: "she leans in",
                    startImage: board.shot("02").image("presenter"),
                  })}
                />
              </Cutin>
            </Composition>
          ))
          .nextGraphicShot("03", bareBoard),
      }),
    });
    expect(video.shots[1]!.cutin).toEqual({ refs: ["video:shot.02.presenter"] });
    expect(listVideoShotPins(video)).toEqual([
      {
        shotId: "01",
        lane: "main",
        pins: [{ pin: "start", reaches: ["animatic:shot.01.first"] }],
        slots: ["start"],
      },
      { shotId: "02", lane: "main", pins: [], slots: [] },
      {
        shotId: "02",
        lane: "cutin",
        pins: [{ pin: "start", reaches: ["animatic:shot.02.presenter"] }],
        slots: ["start"],
      },
      { shotId: "03", lane: "main", pins: [], slots: [] },
    ]);

    const graph = buildDependencyGraph(video, board, reference);
    // 03 spends nothing and builds on no board: a graphic shot is meant to.
    expect(listBoardlessVideoShots(video, board, graph)).toEqual([]);
  });

  it("still refuses a graphic video shot that spends without its board", () => {
    const board = animatic();
    const video = defineVideo(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video
              src={asset("motion", motionComfy, {
                prompt: "x",
                startImage: board.shot("01").image("first"),
              })}
            />
          </Composition>
        ))
          .nextGraphicShot("02", () => (
            <Composition>
              <Cutin>
                <Video src={asset("presenter", motionComfy, { prompt: "she leans in" })} />
              </Cutin>
            </Composition>
          ))
          .nextGraphicShot("03", bareBoard),
      }),
    });
    const graph = buildDependencyGraph(video, board, reference);
    expect(listBoardlessVideoShots(video, board, graph)).toEqual([{ shotId: "02", spends: true }]);
  });

  it("credits a pin to every frame that reaches its take", () => {
    const board = animatic();
    const video = defineVideo(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={asset("motion", motionComfy, { prompt: "x" })} />
          </Composition>
        ))
          .nextGraphicShot("02", () => {
            const take = asset("presenter", motionComfy, {
              prompt: "she leans in",
              startImage: board.shot("02").image("presenter"),
            });
            return (
              <Composition>
                <Video src={take} />
                <Cutin>
                  <Video src={take} />
                </Cutin>
              </Composition>
            );
          })
          .nextGraphicShot("03", bareBoard),
      }),
    });
    const pinned = [{ pin: "start", reaches: ["animatic:shot.02.presenter"] }];
    expect(listVideoShotPins(video).filter((p) => p.shotId === "02")).toEqual([
      { shotId: "02", lane: "main", pins: pinned, slots: ["start"] },
      { shotId: "02", lane: "cutin", pins: pinned, slots: ["start"] },
    ]);
  });

  it("walks only the shot's own stage from what a cutin draws", () => {
    const shot = {
      id: "02",
      assets: { first: { kind: "comfy" as const, workflow: "x.json", inputs: {} } },
      compositionRefs: ["animatic:shot.02.first", "video:shot.02.first"],
      cutin: { refs: ["animatic:shot.02.first"] },
    };
    const chains = shotLaneChains("video", shot);
    expect([...chains.cutin]).toEqual([]);
    expect([...chains.main]).toEqual(["video:shot.02.first"]);
  });

  it("windows a cutin keyframe against the cutin's own list when rendered", () => {
    const window = { assetName: "presenter", assetPath: "animatic:shot.02.presenter" };
    const element = (
      <Composition>
        <Panel src={{ src: "/files/screen.png" }} />
        <Cutin>
          <Panel src={{ src: "/files/presenter.png" }} />
        </Cutin>
      </Composition>
    );
    const html = renderToHtml(element, {
      shotId: "02",
      width: 1024,
      height: 576,
      duration: 4,
      typography: { lang: "en" },
      panels: [
        { assetName: "screen", assetPath: "animatic:shot.02.screen", start: 0, duration: 4 },
      ],
      cutinPanels: [{ ...window, start: 1, duration: 3 }],
    });
    expect(html).toContain('data-konte-cutin=""');
    expect(html).toMatch(/data-konte-panel="presenter" data-start="1" data-duration="3"/);
  });
});

describe("the cutin agreement", () => {
  const withBuilds = (
    two: () => React.ReactElement,
    one: () => React.ReactElement = narrativeBoard,
  ) =>
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", one).nextGraphicShot("02", two).nextGraphicShot("03", bareBoard),
      }),
    });

  it("refuses a shot declaring a cutin its composition never draws", () => {
    expect(() =>
      withBuilds(() => (
        <Composition>
          <div>dashboard</div>
        </Composition>
      )),
    ).toThrow(expect.objectContaining({ code: "CUTIN_REQUIRED" }));
  });

  it("refuses a cutin the shot does not declare", () => {
    expect(() =>
      withBuilds(wipeBoard, () => (
        <Composition>
          <Panel src={asset("first", imageComfy, { prompt: "a desk" })} />
          <Cutin>
            <Panel src={asset("wipe", imageComfy, { prompt: "a girl" })} />
          </Cutin>
        </Composition>
      )),
    ).toThrow(expect.objectContaining({ code: "CUTIN_UNDECLARED" }));
  });

  it("refuses a keyframe in a graphic shot's own picture", () => {
    expect(() =>
      withBuilds(() => (
        <Composition>
          <Panel src={asset("screen", imageComfy, { prompt: "a dashboard" })} />
          <Cutin>
            <Panel src={asset("presenter", imageComfy, { prompt: "a girl" })} />
          </Cutin>
        </Composition>
      )),
    ).toThrow(expect.objectContaining({ code: "ANIMATIC_INVALID" }));
  });

  it("refuses a cutin with no keyframe on the board", () => {
    expect(() =>
      withBuilds(() => (
        <Composition>
          <Cutin>
            <Image src={asset("presenter", imageComfy, { prompt: "a girl" })} />
          </Cutin>
        </Composition>
      )),
    ).toThrow(expect.objectContaining({ code: "PANEL_REQUIRED" }));
  });

  it("refuses a cutin on the video the shot does not declare", () => {
    expect(() =>
      defineVideo(direction, {
        timeline: ({ shot }) => ({
          shots: shot("01", () => (
            <Composition>
              <Cutin>
                <Video src={asset("wipe", motionComfy, { prompt: "x" })} />
              </Cutin>
            </Composition>
          ))
            .nextPendingShot("02")
            .nextPendingShot("03"),
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "CUTIN_UNDECLARED" }));
  });
});

// Each `@ts-expect-error` below would itself error if the call it marks compiled, so the type-level
// constraint and the runtime guard behind it are asserted in one place.
describe("the kind constraint", () => {
  it("keeps `shot` to narrative shots and lets `pendingShot` take either kind", () => {
    defineAnimatic(direction, {
      timeline: ({ graphicShot, pendingShot }) => {
        // @ts-expect-error — "01" is a narrative shot; `shot` is.
        expect(() => graphicShot("01", bareBoard)).toThrow(/not a graphic shot/);
        const chain = pendingShot("01");
        // @ts-expect-error — "02" is a graphic shot; `nextGraphicShot` is the build that fits.
        expect(() => chain.nextShot("02", narrativeBoard)).toThrow(/is a graphic shot/);
        return { shots: chain.nextPendingShot("02").nextPendingShot("03") };
      },
    });
  });

  it("refuses camera fields on a graphic shot and a cutin on an aside", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          // @ts-expect-error — a graphic shot has no camera of its own.
          { kind: "graphic", id: "01", role: "ordinary", action: "a", duration: 2, setup: "front" },
          // @ts-expect-error — an aside is outside the arc, so nothing is wiped in over it.
          {
            kind: "aside",
            id: "op",
            label: "OP",
            duration: 2,
            cutin: { setup: "front", lineup: [] },
          },
        ],
      },
    });
  });
});
