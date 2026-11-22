import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CheckContext,
  collectFindings,
  directionCheckOf,
  withVariantStage,
} from "../../core/checks.js";
import { plainDirection } from "../../core/__tests__/helpers/direction.js";
import type { Direction } from "../../core/dsl/direction.js";
import { type Finding, reviewHold } from "../../core/finding.js";
import { buildDependencyGraph } from "../../core/graph.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  VideoDefinition,
} from "../../core/types/index.js";
import { judgeSpend, patchSpendRequest, spendHeldError } from "../../core/spend-gate.js";
import type { LoadedPatch } from "../../core/patch.js";
import { StateManager } from "../../core/state/index.js";
import { loadCheckContext } from "../../core/check-context.js";

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
    panels: [{ assetName: "first", address: `animatic:shot.${id}.first`, start: 0, duration: 5 }],
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
  cueTakes: "played",
  videoRoot: "",
  direction: null,
  directionUnlocked: false,
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
      addresses: ["video:shot.01.motion", "video:shot.02.motion"],
      targeted: false,
    });
    expect(verdict.findings).toEqual([unconsumed]);
  });

  it("holds a targeted spend only when it names the boardless shot or a timeline asset", () => {
    const reroll = (addresses: string[]) =>
      judgeSpend(ctx, report([unconsumed]), {
        command: "reroll",
        stage: "video",
        addresses,
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
      addresses: ["video:shot.01.motion", "video:shot.02.motion"],
      targeted: false,
    });
    expect([...verdict.held.keys()]).toContain("video:shot.01.motion");
    expect(verdict.held.has("video:shot.02.motion")).toBe(false);
  });
});

describe("judgeSpend on a prompt finding an accept signed off", () => {
  const negation: Finding = {
    code: "prompt-negation",
    subject: '"no outlines"',
    fixIn: { stage: "animatic" },
    message: "",
    targets: ["animatic:shot.02.first"],
    judgedBy: ["animatic:shot.01.first", "animatic:shot.02.first"],
    signedOff: ["animatic:shot.01.first"],
  };
  const spend = (command: "generate" | "reroll", addresses: string[]) =>
    judgeSpend(ctx, report([negation]), {
      command,
      stage: "animatic",
      addresses,
      targeted: command === "reroll",
    });

  it("leaves the signed-off address and what is built on it to a whole-stage spend", () => {
    const verdict = spend("generate", ["animatic:shot.01.first", "animatic:shot.02.first"]);
    expect(verdict.findings).toEqual([]);
    expect([...verdict.held.keys()]).toEqual(["animatic:shot.02.first"]);
  });

  it("never holds the accept that signs it off", () => {
    expect(reviewHold(negation, { op: "accept", address: "animatic:shot.02.first" })).toBe(false);
  });

  it("holds a reroll naming the signed-off address", () => {
    expect(spend("reroll", ["animatic:shot.01.first"]).held.has("animatic:shot.01.first")).toBe(
      true,
    );
  });
});

describe("line-truncated", () => {
  const truncated: Finding = {
    code: "line-truncated",
    subject: "animatic:shot.01#stem",
    fixIn: { stage: "direction" },
    message: "",
    targets: ["animatic:shot.01#stem"],
  };

  it("holds the animatic preview when the fix is in direction.ts", () => {
    expect(reviewHold(truncated, { op: "preview", stage: "animatic" })).toBe(true);
    expect(reviewHold(truncated, { op: "preview", stage: "direction" })).toBe(false);
  });

  it("holds the shot's accept, not its lines'", () => {
    expect(reviewHold(truncated, { op: "accept", address: "animatic:shot.01" })).toBe(true);
    expect(reviewHold(truncated, { op: "accept", address: "animatic:shot.01.line1" })).toBe(false);
  });
});

describe("animatic-unconsumed on a patch", () => {
  const patch = (sourceAddress: string, step: AssetDefinition = comfy) => ({
    sourceVariantId: "v-patch",
    sourceAddress,
    assets: { step },
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
  const patched = async (sourceAddress: string, step?: AssetDefinition) =>
    (
      await collectFindings({
        ...ctx,
        video: footage,
        graph: buildDependencyGraph(footage, animatic),
        patches: [patch(sourceAddress, step)],
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

  it("holds a vendor patch of a shot that spends without its board itself", async () => {
    const found = (
      await collectFindings({ ...ctx, patches: [patch("video:shot.02.motion")] })
    ).findings.filter((f) => f.code === "animatic-unconsumed");
    expect(found.map((f) => f.fixIn)).toEqual([
      { stage: "video" },
      { stage: "video", patch: "v-patch" },
    ]);
  });

  it("counts a panel drawn from a shared asset as the shot's board", async () => {
    const shared: AnimaticDefinition = {
      ...animatic,
      shots: animatic.shots.map((s) =>
        s.id === "02"
          ? {
              ...s,
              assets: {},
              panels: [{ assetName: "style", address: "reference:style", start: 0, duration: 5 }],
            }
          : s,
      ),
    };
    const step = { ...comfy, inputs: { image: "__konte:reference:style__" } };
    const found = (
      await collectFindings({
        ...ctx,
        animatic: shared,
        video: footage,
        graph: buildDependencyGraph(footage, shared),
        patches: [patch("video:shot.02.clip", step)],
      })
    ).findings.filter((f) => f.code === "animatic-unconsumed");
    expect(found).toEqual([]);
  });

  it("counts a board the chain reads through another asset", async () => {
    const bridged: VideoDefinition = {
      ...footage,
      topLevelAssets: {
        bridge: { ...comfy, inputs: { image: "__konte:animatic:shot.02.first__" } },
      },
    };
    const step = { ...comfy, inputs: { image: "__konte:video:timeline.bridge__" } };
    const found = (
      await collectFindings({
        ...ctx,
        video: bridged,
        graph: buildDependencyGraph(bridged, animatic),
        patches: [patch("video:shot.02.clip", step)],
      })
    ).findings.filter((f) => f.code === "animatic-unconsumed" && f.fixIn.patch);
    expect(found).toEqual([]);
  });

  it("never holds a patch that reads the shot's own board", async () => {
    const step = { ...comfy, inputs: { image: "__konte:animatic:shot.02.first__" } };
    expect(await patched("video:shot.02.clip", step)).toEqual([]);
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
        cueTakes: "played",
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

describe("judgeSpend on a patch application", () => {
  const source = "video:shot.01.motion";
  const patchOf = (stepInputs: Record<string, string>) =>
    ({
      sourceVariantId: "v-src",
      sourceAddress: source,
      filePath: "patches/v-src.ts",
      patchHash: "h",
      outputName: "fix",
      assets: { fix: { ...comfy, inputs: { image: `__konte:${source}__`, ...stepInputs } } },
    }) as unknown as LoadedPatch;
  const sourceOnly = patchOf({});
  const withBoard = patchOf({ reference: "__konte:animatic:shot.02.first__" });
  const held = (c: CheckContext, findings: Finding[], patch: LoadedPatch) =>
    spendHeldError(
      patchSpendRequest(patch, "patch"),
      judgeSpend(c, report(findings), patchSpendRequest(patch, "patch")),
    );

  it("leaves a finding on the source's own definition to the source", () => {
    const negation: Finding = {
      code: "prompt-negation",
      subject: '"no blur"',
      fixIn: { stage: "video" },
      message: "",
      targets: [source],
      judgedBy: [source],
    };
    expect(held(ctx, [negation], sourceOnly)).toBeNull();
  });

  it("holds on a finding over what the chain reads", () => {
    const negation: Finding = {
      code: "prompt-negation",
      subject: '"no blur"',
      fixIn: { stage: "animatic" },
      message: "",
      targets: ["animatic:shot.02.first"],
      judgedBy: ["animatic:shot.02.first"],
    };
    const other: Finding = {
      ...negation,
      targets: ["animatic:shot.01.first"],
      judgedBy: ["animatic:shot.01.first"],
    };
    const error = held(ctx, [negation, other], withBoard);
    expect(error?.code).toBe("SPEND_HELD");
    expect(error?.items.join("\n")).toContain("animatic:shot.02.first");
    expect(error?.items.join("\n")).not.toContain("animatic:shot.01.first");
  });

  it("leaves a read take whose accept signed the finding off", () => {
    const signedOff: Finding = {
      code: "prompt-negation",
      subject: '"no blur"',
      fixIn: { stage: "animatic" },
      message: "",
      targets: [],
      judgedBy: ["animatic:shot.02.first"],
      signedOff: ["animatic:shot.02.first"],
    };
    expect(held(ctx, [signedOff], withBoard)).toBeNull();
  });

  it("is not held by another shot's board wiring for what it reads off the shots", () => {
    const unconsumed: Finding = {
      code: "animatic-unconsumed",
      subject: "video:shot.02",
      fixIn: { stage: "video" },
      message: "",
      targets: ["video:shot.02"],
    };
    expect(held(ctx, [unconsumed], patchOf({ style: "__konte:reference:style__" }))).toBeNull();
  });

  it("asks for what the chain reads accepted, not the source's own upstream", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-gate-"));
    try {
      const withState = { ...ctx, manager: await StateManager.init(dir) };
      expect(held(withState, [], sourceOnly)).toBeNull();
      expect(held(withState, [], withBoard)?.items.join("\n")).toContain("animatic:shot.02.first");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withVariantStage", () => {
  it("shares the direction check of the context it narrows", () => {
    const withDirection: CheckContext = {
      ...ctx,
      direction: plainDirection as unknown as Direction,
    };
    const check = directionCheckOf(withDirection);
    expect(check).not.toBeNull();
    expect(directionCheckOf(withVariantStage(withDirection, "video"))).toBe(check);
  });
});
