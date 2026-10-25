import { describe, expect, it } from "vitest";
import { type CheckContext, collectFindings } from "../../core/checks.js";
import type { Finding } from "../../core/finding.js";
import { buildDependencyGraph } from "../../core/graph.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import { judgeSpend, loadCheckContext } from "../finding-gates.js";

const format = { size: { width: 100, height: 100 }, fps: 30 };
const comfy = { kind: "comfy" as const, workflow: "x.json", inputs: {} };

const animatic: AnimaticDefinition = {
  stage: "animatic",
  format,
  typography: { lang: "en" },
  shots: ["01", "02"].map((id) => ({
    id,
    duration: 5,
    action: `shot ${id}`,
    assets: { first: comfy },
    panels: [{ assetName: "first", assetPath: `animatic:shot.${id}.first`, start: 0, duration: 5 }],
  })),
};

// Shot 01 builds on its board; shot 02 spends on a model of its own.
const video: VideoDefinition = {
  stage: "video",
  format,
  typography: { lang: "en" },
  shots: [
    {
      id: "01",
      duration: 5,
      action: "shot 01",
      assets: {
        motion: { ...comfy, inputs: { image: "__konte:animatic:shot.01.first__" } },
      },
    },
    { id: "02", duration: 5, action: "shot 02", assets: { motion: comfy } },
  ],
};

const graph = buildDependencyGraph(video, animatic);

const ctx: CheckContext = {
  videoRoot: "",
  direction: null,
  directionAccepted: false,
  reference: null,
  animatic,
  video,
  manager: null,
  graph,
  patches: [],
  lang: null,
};

const report = (findings: Finding[]) => ({ findings, staleWaivers: [] });

describe("judgeSpend", () => {
  const unconsumed: Finding = {
    code: "animatic-unconsumed",
    subject: "video:shot.02",
    fixIn: { stage: "video" },
    message: "",
    targets: ["video:shot.02"],
  };

  it("holds a whole-stage spend on a boardless shot", () => {
    const verdict = judgeSpend(ctx, report([unconsumed]), {
      command: "generate",
      stage: "video",
      assetPaths: ["video:shot.01.motion", "video:shot.02.motion"],
      targeted: false,
    });
    expect(verdict.findings).toEqual([unconsumed]);
  });

  it("holds a targeted spend only when it names the boardless shot or a timeline asset", () => {
    const reroll = (assetPaths: string[]) =>
      judgeSpend(ctx, report([unconsumed]), {
        command: "reroll",
        stage: "video",
        assetPaths,
        targeted: true,
      }).findings;
    expect(reroll(["video:shot.01.motion"])).toEqual([]);
    expect(reroll(["video:shot.02.motion"])).toEqual([unconsumed]);
    expect(reroll(["video:timeline.bg"])).toEqual([unconsumed]);
  });

  it("holds what a downstream stage builds on a pending reference", () => {
    const pending: Finding = {
      code: "pending-reference",
      subject: "animatic:shot.01.first",
      fixIn: { stage: "animatic" },
      message: "",
      targets: ["animatic:shot.01.first"],
    };
    const verdict = judgeSpend(ctx, report([pending]), {
      command: "generate",
      stage: "video",
      assetPaths: ["video:shot.01.motion", "video:shot.02.motion"],
      targeted: false,
    });
    expect([...verdict.held.keys()]).toContain("video:shot.01.motion");
    expect(verdict.held.has("video:shot.02.motion")).toBe(false);
  });
});

describe("animatic-unconsumed on a patch", () => {
  const patch = (sourceAddress: string) => ({
    sourceVariantId: "v-patch",
    sourceAddress,
    assets: { step: comfy },
  });
  const footage: VideoDefinition = {
    ...video,
    shots: [
      video.shots[0]!,
      {
        id: "02",
        duration: 5,
        action: "shot 02",
        // Cut from another shot's board, never its own.
        assets: {
          clip: {
            kind: "local",
            operation: "resize",
            inputs: { image: "__konte:animatic:shot.01.first__" },
          } as unknown as AssetDefinition,
        },
      },
    ],
  };
  const patched = async (sourceAddress: string) =>
    (
      await collectFindings({
        ...ctx,
        video: footage,
        graph: buildDependencyGraph(footage, animatic),
        patches: [patch(sourceAddress)],
      })
    ).findings.filter((f) => f.code === "animatic-unconsumed");

  it("holds a vendor patch of a boardless video take", async () => {
    expect((await patched("video:shot.02.clip")).map((f) => f.fixIn)).toEqual([
      { stage: "video", patch: "v-patch" },
    ]);
  });

  it("never holds a patch of another stage", async () => {
    expect(await patched("animatic:shot.01.first")).toEqual([]);
  });
});

describe("loadCheckContext", () => {
  it("finds a reference into a pendingShot on a board reviewed before video.tsx exists", async () => {
    const board: AnimaticDefinition = {
      ...animatic,
      shots: [
        {
          ...animatic.shots[0]!,
          assets: { first: { ...comfy, inputs: { image: "__konte:animatic:shot.02.first__" } } },
        },
        { id: "02", duration: 5, action: "shot 02", assets: {}, pending: true },
      ],
    };
    const found = await collectFindings(
      await loadCheckContext({
        videoRoot: "",
        definitions: { reference: null, animatic: board, video: null },
        direction: null,
        manager: null,
      }),
    );
    expect(
      found.findings.filter((f) => f.code === "pending-reference").map((f) => f.subject),
    ).toEqual(["animatic:shot.01.first"]);
  });
});
