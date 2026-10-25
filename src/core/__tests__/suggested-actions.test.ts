import { describe, expect, it } from "vitest";
import { dedupeCommands, formatSuggestedActions, suggestForStatus } from "../suggested-actions.js";
import type { ExportReadiness } from "../status-sections.js";
import type { KonteState } from "../types/index.js";
import type { Finding, FindingCode } from "../finding.js";
import type { Stage } from "../address.js";

function finding(code: FindingCode, stage: Stage, extra: Partial<Finding> = {}): Finding {
  return { code, subject: "", fixIn: { stage }, message: "m", ...extra };
}

// The report's per-stage readiness — the only thing that knows an asset was never generated
// (an ungenerated asset has no state entry to find).
function readinessFor(
  label: string,
  notGenerated: string[],
  needsRegenerate: string[] = [],
): ExportReadiness {
  return {
    label,
    total: notGenerated.length,
    accepted: 0,
    missing: [...notGenerated],
    generated: 0,
    notGenerated,
    needsRegenerate,
    inFlight: 0,
    staleAwaitingReroll: [],
    staleAwaitingAccept: [],
    filesMissing: [],
    pendingShots: 0,
    unacceptedCast: [],
    deliveryUpscalerMissing: false,
    leavesUnsigned: false,
    refsUnaccepted: 0,
    reel: null,
  };
}

function makeState(assets: KonteState["assets"]): KonteState {
  return { schemaVersion: 2, assets };
}

function problemVariant() {
  return {
    status: "none" as const,
    outputHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    inputFingerprints: {},
    file: null,
    definitionHash: null,
    metadata: {},
  };
}

describe("suggestForStatus", () => {
  it("gives each file a finding is fixed in its own edit step, direction first", () => {
    const actions = suggestForStatus({
      state: { schemaVersion: 2, assets: {} },
      findings: [
        finding("narration-overflow", "animatic", { subject: "animatic:shot.09#stem" }),
        finding("narration-overflow", "direction", { subject: "animatic:shot.10#stem" }),
      ],
    });
    expect(actions.slice(0, 2)).toEqual([
      {
        command: null,
        label: "edit direction.ts",
        details: ["Fix the 1 finding(s) listed under it below"],
      },
      {
        command: null,
        label: "edit animatic.tsx",
        details: ["Fix the 1 finding(s) listed under it below"],
      },
    ]);
  });

  it("suggests preview video for video pending variants", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.includes("preview video"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("preview animatic"))).toBe(false);
  });

  it("offers the video spend that re-mixes a board stem the video took over", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      boardRemixAddresses: ["animatic:shot.02#stem"],
    });
    expect(actions.map((a) => a.command)).toContain("konte generate video");
    expect(
      suggestForStatus({ state: makeState({}), boardRemixAddresses: [] }).map((a) => a.command),
    ).not.toContain("konte generate video");
  });

  it("merges the details of every twin of a command, saying a repeated one once", () => {
    const result = formatSuggestedActions(
      dedupeCommands([
        { command: "konte preview video", details: ["a comment stands", "shared"] },
        { command: "konte preview video", details: ["shared", "1 shot held"] },
      ]),
    );
    expect(result).toBe(
      [
        "Next steps:",
        "  konte preview video",
        "    a comment stands",
        "    shared",
        "    1 shot held",
      ].join("\n"),
    );
  });

  it("honors an explicit Needs review set over the state-only heuristic", () => {
    // The state-only fallback (`hasFreshPending`) would flag this variant as pending
    // review, but the caller's definition-aware set excludes it (e.g. a definition-stale
    // composition) — so no preview is suggested.
    const state = makeState({
      "video:shot.03#composition": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "composition.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    expect(suggestForStatus({ state }).some((a) => a.command?.includes("preview"))).toBe(true);
    expect(
      suggestForStatus({ state, pendingReviewAddresses: [] }).some((a) =>
        a.command?.includes("preview"),
      ),
    ).toBe(false);
  });

  it("probes a variant finding in place of the review it holds", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      pendingReviewAddresses: ["animatic:shot.35.line"],
      findings: [
        finding("line-misheard", "animatic", {
          subject: "v-a",
          targets: ["animatic:shot.35.line"],
        }),
      ],
      previewHeldStages: ["animatic"],
    });

    expect(actions).toEqual([
      {
        command: "konte probe audio v-a",
        details: [
          "Dismiss a broken take (reroll for another beside it); `konte vouch <variantId>` one that is fine",
        ],
      },
    ]);
  });

  it("suggests preview animatic for animatic pending variants", () => {
    const state = makeState({
      "animatic:shot.01.first": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.includes("preview animatic"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("preview video"))).toBe(false);
  });

  it("suggests both previews when both stages have pending variants", () => {
    const state = makeState({
      "animatic:shot.01.first": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "video:shot.01.motion": {
        variants: {
          v002: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.includes("preview animatic"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("preview video"))).toBe(true);
  });

  it("does not suggest re-review when an asset is accepted but has leftover unpicked variants", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "picked.mp4",
            definitionHash: null,
            metadata: {},
          },
          v002: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "alt.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.includes("preview"))).toBe(false);
  });

  it("excludes input-stale variants from needs review", () => {
    const state = makeState({
      "video:shot.01.bg": {
        variants: {
          "v-up": {
            status: "accepted",
            outputHash: "current",
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "bg.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.bg": "outdated" },
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.includes("preview"))).toBe(false);
  });

  it("suggests clean for problem assets", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: null,
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command === "konte clean video:shot.01.motion")).toBe(true);
  });

  it("does not suggest clean for a still-generating variant when given the job-aware problem set", () => {
    // A running variant has no file yet and no error, so the state-only fallback would
    // wrongly flag it. The caller passes the report's job-aware (empty) problem set instead.
    const state = makeState({
      "video:shot.06.motion": { variants: { v001: problemVariant() } },
    });

    const actions = suggestForStatus({ state, pendingReviewAddresses: [], problemAddresses: [] });
    expect(actions.some((a) => a.command?.startsWith("konte clean"))).toBe(false);
  });

  it("suggests clean only for the addresses in the caller-supplied problem set", () => {
    const state = makeState({
      "video:shot.01.motion": { variants: { v001: problemVariant() } },
      "video:shot.06.motion": { variants: { v006: problemVariant() } },
    });

    const actions = suggestForStatus({
      state,
      pendingReviewAddresses: [],
      problemAddresses: ["video:shot.01.motion"],
    });
    const cleanCommands = actions.filter((a) => a.command?.startsWith("konte clean"));
    expect(cleanCommands).toHaveLength(1);
    expect(cleanCommands[0]?.command).toBe("konte clean video:shot.01.motion");
  });

  it("groups problem cleans per scope across stages", () => {
    const state = makeState({
      "video:shot.01.motion": { variants: { v001: problemVariant() } },
      "video:shot.02.motion": { variants: { v002: problemVariant() } },
      "animatic:shot.01.first": { variants: { v003: problemVariant() } },
    });

    const actions = suggestForStatus({ state });
    const cleanCommands = actions
      .filter((a) => a.command?.startsWith("konte clean"))
      .map((a) => a.command);
    expect(cleanCommands).toContain("konte clean video");
    expect(cleanCommands).toContain("konte clean animatic:shot.01.first");
    expect(cleanCommands).not.toContain("konte clean video:shot.01.motion");
  });

  it("suggestForStageStatus groups multiple problems into one scoped clean", () => {
    const state = makeState({
      "video:shot.01.motion": { variants: { v001: problemVariant() } },
      "video:shot.02.motion": { variants: { v002: problemVariant() } },
    });

    const actions = suggestForStatus({ state });
    const cleanCommands = actions.filter((a) => a.command?.startsWith("konte clean"));
    expect(cleanCommands).toHaveLength(1);
    expect(cleanCommands[0]?.command).toBe("konte clean video");
  });

  it("suggests nothing for an accepted take whose input moved", () => {
    const state = makeState({
      "video:shot.01.first": {
        variants: {
          up: {
            status: "accepted",
            outputHash: "current-hash",
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "first.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: { "video:shot.01.first": "old-hash" },
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.map((a) => a.command)).toEqual([]);
  });

  it("ignores stale non-accepted variants", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "none",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions.some((a) => a.command?.startsWith("konte reroll"))).toBe(false);
  });

  it("leaves input-stale accepts standing", () => {
    const upstream = {
      status: "accepted" as const,
      outputHash: "current-hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      inputFingerprints: {},
      file: "up.png",
      definitionHash: null,
      metadata: {},
    };
    const staleConsumer = (file: string) => ({
      status: "accepted" as const,
      outputHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      inputFingerprints: { "video:timeline.bg": "old-hash" },
      file,
      definitionHash: null,
      metadata: {},
    });
    const state = makeState({
      "video:timeline.bg": { variants: { up: upstream } },
      "video:shot.01.motion": { variants: { v001: staleConsumer("out1.mp4") } },
      "video:shot.02.motion": { variants: { v002: staleConsumer("out2.mp4") } },
      "video:shot.03.motion": { variants: { v003: staleConsumer("out3.mp4") } },
    });

    // No readiness: nothing is awaiting a first generate, so the stale routing is the only thing
    // that can put a command in the block.
    const actions = suggestForStatus({ state });
    expect(actions.map((a) => a.command)).toEqual([]);
  });

  // The one stale accept `generate` does re-bake: konte stamped that accept itself.
  it("groups deterministic stale accepts into a stage-wide generate", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      staleAddresses: [],
      deterministicStaleAddresses: ["video:shot.01.depth", "video:shot.02.depth"],
    });
    expect(actions.map((a) => a.command)).toEqual(["konte generate video"]);
  });

  it("returns empty when no actions needed", () => {
    const state = makeState({
      "video:shot.01.motion": {
        variants: {
          v001: {
            status: "accepted",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "out.mp4",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });

    const actions = suggestForStatus({ state });
    expect(actions).toEqual([]);
  });

  it("names undeveloped video shots whose board is accepted", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      boardedPendingVideoShots: ["03", "04"],
      nextSequencePendingShots: { animatic: [], video: ["03", "04"] },
    });
    expect(actions).toEqual([
      {
        command: null,
        label: "edit",
        details: ["Develop video shots 03, 04 in video.tsx from the accepted animatic"],
      },
    ]);
  });

  it("names the next sequence's undeveloped shots once nothing else is left", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      nextSequencePendingShots: { animatic: ["05"], video: ["05"] },
    });
    expect(actions).toEqual([
      {
        command: null,
        label: "edit",
        details: [
          "Develop the next sequence: animatic shot 05 in animatic.tsx, video shot 05 in video.tsx",
        ],
      },
    ]);
  });

  it("holds the next sequence back while other work is offered", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      readiness: [readinessFor("animatic", ["shot.01.first"])],
      nextSequencePendingShots: { animatic: ["05"], video: ["05"] },
    });
    expect(actions).toEqual([{ command: "konte generate animatic" }]);
  });

  it("names no development while the direction holds the spend", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      directionReviewNeeded: true,
      boardedPendingVideoShots: ["03"],
    });
    expect(actions.some((a) => a.command === null && a.label === "edit")).toBe(false);
  });

  it("suggests generate for a stage the report says has something ungenerated", () => {
    const state = makeState({ "video:shot.01.motion": { variants: {} } });

    const actions = suggestForStatus({
      state,
      readiness: [readinessFor("video", ["shot.01.motion"])],
    });
    expect(actions.some((a) => a.command?.includes("generate video"))).toBe(true);
  });

  // An asset whose only takes have gone stale is work `generate` does, exactly like a never-made one.
  it("suggests generate for a stage whose only takes have gone stale", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      readiness: [readinessFor("video", [], ["shot.01.motion"])],
    });
    expect(actions).toEqual([{ command: "konte generate video" }]);
  });

  it("suggests generate for an asset that has never been generated, so has no state entry", () => {
    // The whole point of taking readiness from the report: `state.assets` is empty here, yet a
    // definition-declared asset is waiting to be made.
    const actions = suggestForStatus({
      state: makeState({}),
      readiness: [readinessFor("animatic", ["shot.01.first"])],
    });
    expect(actions).toEqual([{ command: "konte generate animatic" }]);
  });

  it("suggests generate animatic when animatic assets have no accepted variants", () => {
    const state = makeState({
      "animatic:shot.01.first": {
        variants: {},
      },
    });

    const actions = suggestForStatus({
      state,
      readiness: [readinessFor("animatic", ["shot.01.first"])],
    });
    expect(actions.some((a) => a.command?.includes("generate animatic"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("generate video"))).toBe(false);
  });

  it("suggests both generate commands when both stages have unaccepted assets", () => {
    const state = makeState({
      "animatic:shot.01.first": {
        variants: {},
      },
      "video:shot.01.motion": {
        variants: {},
      },
    });

    const actions = suggestForStatus({
      state,
      readiness: [
        readinessFor("animatic", ["shot.01.first"]),
        readinessFor("video", ["shot.01.motion"]),
      ],
    });
    expect(actions.some((a) => a.command?.includes("generate animatic"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("generate video"))).toBe(true);
  });

  it("holds back video suggestions while a consumed board is unaccepted", () => {
    // `generate video` would be held by the spend gate, so it must not be offered;
    // the animatic's own suggestions stay live — they are the way through the gate.
    const state = makeState({
      "animatic:shot.01.first": { variants: {} },
      "video:shot.01.motion": { variants: {} },
    });

    const actions = suggestForStatus({
      state,
      readiness: [
        readinessFor("animatic", ["shot.01.first"]),
        readinessFor("video", ["shot.01.motion"]),
      ],
      spendHeldStages: ["video"],
    });
    expect(actions.some((a) => a.command?.includes("generate animatic"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("generate video"))).toBe(false);
  });

  it("holds back animatic suggestions while a consumed sheet is unaccepted", () => {
    // The same gate one stage up: `generate animatic` would be held, so only the reference stage's
    // own suggestions stay live.
    const state = makeState({
      "reference:ferry": { variants: {} },
      "animatic:shot.01.first": { variants: {} },
    });

    const actions = suggestForStatus({
      state,
      readiness: [
        readinessFor("reference", ["ferry"]),
        readinessFor("animatic", ["shot.01.first"]),
      ],
      spendHeldStages: ["animatic", "video"],
    });
    expect(actions.some((a) => a.command?.includes("generate reference"))).toBe(true);
    expect(actions.some((a) => a.command?.includes("generate animatic"))).toBe(false);
  });

  it("leads with the class edit, holding back the spend and a review the class refuses", () => {
    const state = makeState({ "video:shot.01.motion": { variants: {} } });
    const suggest = (review: boolean) =>
      suggestForStatus({
        state,
        readiness: [readinessFor("video", ["shot.01.motion"])],
        pendingReviewAddresses: ["video:shot.01.motion"],
        staleAddresses: ["video:shot.02#composition"],
        findings: [
          finding(review ? "composition-class-font-family" : "class-font-family", "video"),
        ],
        spendHeldStages: ["video"],
        previewHeldStages: review ? ["video"] : [],
      });

    const refused = suggest(true);
    expect(refused[0]).toEqual({
      command: null,
      label: "edit video.tsx",
      details: ["Fix the 1 finding(s) listed under it below"],
    });
    expect(refused.some((a) => a.command?.includes("generate video"))).toBe(false);
    expect(refused.some((a) => a.command === "konte preview video")).toBe(false);

    const imageOnly = suggest(false);
    expect(imageOnly.some((a) => a.command?.includes("generate video"))).toBe(false);
    expect(imageOnly.some((a) => a.command === "konte preview video")).toBe(true);
  });
});

describe("formatSuggestedActions", () => {
  it("returns empty string for empty array", () => {
    expect(formatSuggestedActions([])).toBe("");
  });

  describe("standing feedback", () => {
    const addresses = [
      "animatic:shot.08.frame",
      "video:shot.11",
      "video:timeline#stem",
      "reference:studio",
    ];

    // Which fix a comment needs is a routing decision konte cannot make from the fact that one
    // exists — so it names the command that shows the words, and counts what is waiting.
    it("points at the comments rather than guessing the fix", () => {
      const rendered = formatSuggestedActions(
        suggestForStatus({ state: makeState({}), feedbackAddresses: addresses }),
      );
      expect(rendered).toContain("konte review feedback list");
      expect(rendered).toContain("4 addresses carry comments");
      expect(rendered).not.toContain("konte patch new");
      expect(rendered).not.toContain("konte reroll");
    });

    it("counts one address in the singular", () => {
      const rendered = formatSuggestedActions(
        suggestForStatus({ state: makeState({}), feedbackAddresses: addresses.slice(0, 1) }),
      );
      expect(rendered).toContain("1 address carries a comment");
    });

    // Reading spends nothing, so a gate that would abort every generate has no say here.
    it("surfaces them even while the direction gate blocks every spend", () => {
      const commands = suggestForStatus({
        state: makeState({}),
        feedbackAddresses: addresses,
        directionReviewNeeded: true,
      }).flatMap((a) => (a.command === null ? [] : [a.command]));
      expect(commands).toContain("konte review feedback list");
    });

    it("says nothing with no standing comment", () => {
      const rendered = formatSuggestedActions(
        suggestForStatus({ state: makeState({}), feedbackAddresses: [] }),
      );
      expect(rendered).not.toContain("carries a comment");
      expect(rendered).not.toContain("konte review feedback list");
    });
  });

  it("directs a completed working-size export to verification instead of another export", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      lastExports: [
        {
          label: "video",
          noDelivery: true,
          outputFile: "dist/video/check_no_delivery/video.mp4",
          completedAt: "2026-07-16T00:00:00.000Z",
          outOfDate: false,
        },
      ],
    });
    expect(actions).toContainEqual({ command: "konte probe export" });
    expect(actions).not.toContainEqual({ command: "konte export video" });
  });

  it("offers no export while a video leaf awaits its accept", () => {
    const accepted = { ...readinessFor("video", []), total: 1, accepted: 1 };
    const exportOf = (leavesUnsigned: boolean) =>
      suggestForStatus({
        state: makeState({}),
        readiness: [{ ...accepted, leavesUnsigned }],
      }).some((a) => a.command === "konte export video");
    expect(exportOf(false)).toBe(true);
    expect(exportOf(true)).toBe(false);
  });

  it("formats commands bare — a command describes itself, so it carries no comment", () => {
    const result = formatSuggestedActions([
      { command: "konte export video" },
      { command: "konte reroll video:shot.05.motion" },
    ]);
    expect(result).toBe(
      ["Next steps:", "  konte export video", "  konte reroll video:shot.05.motion"].join("\n"),
    );
  });

  it("parenthesizes a step no command performs, so it does not read as one to run", () => {
    const result = formatSuggestedActions([
      {
        command: null,
        label: "async",
        details: ["Jobs keep running after this command returns"],
      },
      { command: "konte job wait" },
    ]);
    expect(result).toBe(
      [
        "Next steps:",
        "  (async)",
        "    Jobs keep running after this command returns",
        "  konte job wait",
      ].join("\n"),
    );
  });

  // Which step a detail is about is the indent, not the line above it — so a detail cannot be read
  // against the wrong step however the list is ordered or deduped.
  it("indents every detail under the step that carries it", () => {
    const result = formatSuggestedActions([
      { command: "konte preview video", details: ["1 address carries a comment", "2 shots held"] },
      { command: "konte generate video" },
    ]);
    expect(result).toBe(
      [
        "Next steps:",
        "  konte preview video",
        "    1 address carries a comment",
        "    2 shots held",
        "  konte generate video",
      ].join("\n"),
    );
  });
});

describe("direction review is surfaced first", () => {
  it("prepends `konte preview direction` when the direction is unaccepted", () => {
    const actions = suggestForStatus({ state: makeState({}), directionReviewNeeded: true });
    expect(actions[0]).toEqual({ command: "konte preview direction" });
  });

  it("omits it when the direction is accepted", () => {
    const actions = suggestForStatus({ state: makeState({}), directionReviewNeeded: false });
    expect(actions.some((a) => a.command === "konte preview direction")).toBe(false);
  });

  it("prepends it ahead of the other suggestions", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      directionReviewNeeded: true,
    });
    expect(actions[0]?.command).toBe("konte preview direction");
  });
});

// The edit step names the file the fix is written in, and that is not always the direction: a roster
// entry with no reference asset is answered in reference.tsx, and the roster itself is already right.
describe("the finding edit step names the file the fix belongs in", () => {
  const editSteps = (input: Parameters<typeof suggestForStatus>[0]) =>
    suggestForStatus(input).filter(
      (a): a is { command: null; label: string; details: readonly string[] } =>
        a.command === null && a.label.startsWith("edit "),
    );

  it("points at reference.tsx, keeping the waiver's file as the other way out", () => {
    const [step] = editSteps({
      state: makeState({}),
      findings: [
        finding("character-unreferenced", "reference"),
        finding("narrator-unreferenced", "reference"),
      ],
    });
    expect(step?.label).toBe("edit reference.tsx");
    expect(step?.details.join("\n")).toContain("waive a waivable one by its key in direction.ts");
  });

  // Next steps prints ABOVE the Findings block (print-status), so every step sends the reader down.
  it("points every file's step down the page at the findings", () => {
    const steps = editSteps({
      state: makeState({}),
      findings: [
        finding("character-unreferenced", "reference"),
        finding("setup-unrealized", "animatic"),
        finding("multi-sentence-action", "direction"),
      ],
    });
    expect(steps.map((s) => s.label)).toEqual([
      "edit direction.ts",
      "edit reference.tsx",
      "edit animatic.tsx",
    ]);
    for (const step of steps) expect(step.details.join("")).toContain("below");
  });

  it("names no waiver where no finding in the file is waivable", () => {
    const [step] = editSteps({
      state: makeState({}),
      findings: [finding("duplicate-id", "direction")],
    });
    expect(step?.details).toEqual(["Fix the 1 finding(s) listed under it below"]);
  });

  it("keeps offering animatic generation while only video findings hold", () => {
    const actions = suggestForStatus({
      state: makeState({}),
      findings: [finding("passer-unconsumed", "video"), finding("passer-unnamed", "video")],
      spendHeldStages: ["video"],
      readiness: [
        readinessFor("animatic", ["shot.01.first"]),
        readinessFor("video", ["shot.01.motion"]),
      ],
    });
    expect(actions).toContainEqual({ command: "konte generate animatic" });
    expect(actions).not.toContainEqual({ command: "konte generate video" });
  });

  it("omits the steps for a shotless direction, which has its own note", () => {
    const steps = editSteps({
      state: makeState({}),
      findings: [finding("character-unreferenced", "reference")],
      directionEmpty: true,
    });
    expect(steps).toHaveLength(0);
  });
});

// Which step the cast asks for turns on where its reference stalled.
describe("suggestForStatus cast gate scope", () => {
  const readiness = [
    readinessFor("animatic", ["animatic:shot.01.first"]),
    readinessFor("video", ["video:shot.01.motion"]),
  ];
  const commands = (
    cast: { id: string; declared: boolean; missingFile: string | null; blocks: "all" | "video" }[],
  ) =>
    suggestForStatus({ state: makeState({}), readiness, unacceptedCast: cast })
      .map((a) => ("command" in a ? a.command : null))
      .filter((c): c is string => c !== null);

  // A sheet whose only take was decided against has nothing to go and look at: the way out is
  // another generate, not a review of the picture the reviewer already said no to.
  it("sends a cast sheet holding only a dismissed take back to generate", () => {
    const dismissedSheet = makeState({
      "reference:hero": {
        variants: {
          "v-gone0001": {
            status: "dismissed",
            outputHash: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputFingerprints: {},
            file: "hero.png",
            definitionHash: null,
            metadata: {},
          },
        },
      },
    });
    const offered = suggestForStatus({
      state: dismissedSheet,
      readiness,
      unacceptedCast: [{ id: "hero", declared: true, missingFile: null, blocks: "all" }],
    })
      .map((a) => ("command" in a ? a.command : null))
      .filter((c): c is string => c !== null);
    expect(offered).toContain("konte generate reference");
    expect(offered).not.toContain("konte preview reference");
  });

  it("offers no reference step for a cast member reference.tsx does not declare", () => {
    const offered = commands([{ id: "hero", declared: false, missingFile: null, blocks: "all" }]);
    expect(offered).not.toContain("konte generate reference");
    expect(offered).not.toContain("konte preview reference");
  });
});

describe("suggestForStatus — jobs in flight", () => {
  const state = makeState({});
  const commands = (input: Partial<Parameters<typeof suggestForStatus>[0]>) =>
    suggestForStatus({ state, pendingReviewAddresses: ["video:shot.01.motion"], ...input }).map(
      (a) => a.command,
    );

  it("offers the wait ahead of the review while a job runs", () => {
    const offered = commands({ jobsInFlight: true });
    expect(offered.indexOf("konte job wait")).toBeLessThan(offered.indexOf("konte preview video"));
  });

  it("offers no wait with nothing in flight", () => {
    expect(commands({})).not.toContain("konte job wait");
  });

  it("offers each stuck job's diagnosis ahead of the wait", () => {
    const offered = commands({ jobsInFlight: true, stuckJobIds: ["v-a", "v-b"] });
    expect(offered.slice(0, 3)).toEqual([
      "konte job show v-a",
      "konte job show v-b",
      "konte job wait",
    ]);
  });
});
