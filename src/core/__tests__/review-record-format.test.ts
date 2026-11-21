import { describe, expect, it } from "vitest";
import { hasFeedback, type ReviewRecord } from "../review-record.js";
import {
  countReviewAssets,
  countReviewFeedback,
  formatReviewRecord,
  reviewNoteFrameTargets,
} from "../review-record-format.js";

describe("formatReviewRecord", () => {
  it("reports each accepted direction section under Accepted", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:");
    expect(out).toContain("  direction:shots");
    expect(out).not.toContain("Accepted: none submitted");
  });

  // A leaf's skip reason carries the inputs that held it back and the command that clears them, so
  // the block has to keep them under their address instead of running them into one line.
  it("indents a skip reason's own detail lines under its address", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      skippedDecisions: [
        {
          address: "video:shot.01#composition",
          reason: [
            "the composition could not be materialized; these inputs have no take a spend may use:",
            "animatic:shot.01.first (input-stale: reference:hero)",
            "konte generate animatic",
          ].join("\n"),
        },
      ],
    };

    expect(formatReviewRecord(record)).toContain(
      [
        "Not settled:",
        "  video:shot.01#composition — the composition could not be materialized; these inputs have no take a spend may use:",
        "    animatic:shot.01.first (input-stale: reference:hero)",
        "    konte generate animatic",
      ].join("\n"),
    );
  });

  it("reports a direction section by its code key, with no UI-label parenthetical", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { characters: "accepted", policy: "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("  direction:characters");
    expect(out).toContain("  direction:policy");
    expect(out).not.toContain("(Characters)");
    expect(out).not.toContain("direction:characters (");
  });

  it("reports an un-accepted direction section under Accept withdrawn", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "none" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: none submitted");
    expect(out).toContain("Accept withdrawn:");
    expect(out).toContain("  direction:shots");
  });

  it("reports how many parts the direction gate still blocked at submit", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { policy: "accepted" },
      directionGate: { open: false, blocking: 3, total: 12 },
    };

    expect(formatReviewRecord(record)).toContain(
      "Gate at submit: 3 of 12 parts still needed review",
    );
  });

  it("reports an open direction gate", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { policy: "accepted" },
      directionGate: { open: true, blocking: 0, total: 12 },
    };

    expect(formatReviewRecord(record)).toContain(
      "Gate at submit: open — the direction no longer blocks generation",
    );
  });

  it("omits the gate line for a stage that has none", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };

    expect(formatReviewRecord(record)).not.toContain("Gate at submit:");
  });
});

describe("countReviewFeedback", () => {
  it("sums feedback across an entry-array stage's decisions", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "a",
          feedback: [
            { id: "f1", annotation: null, text: "x", stale: false },
            { id: "f2", annotation: null, text: "y", stale: false },
          ],
        },
        { address: "b", feedback: [{ id: "f3", annotation: null, text: "z", stale: false }] },
      ],
    };
    expect(countReviewFeedback(record)).toBe(3);
  });

  it("skips carried-over stale feedback so the count matches what `record show` prints", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          feedback: [
            { id: "f1", annotation: null, text: "carried over", stale: true },
            { id: "f2", annotation: null, text: "written now", stale: true, added: true },
            { id: "f3", annotation: null, text: "live", stale: false },
          ],
        },
      ],
    };
    expect(countReviewFeedback(record)).toBe(2);
  });

  it("counts notes for video-preview", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
      notes: [
        { time: 1, address: "video", text: "a" },
        { time: 2, address: "video", text: "b" },
      ],
    };
    expect(countReviewFeedback(record)).toBe(2);
  });

  it("returns 0 for video-preview without notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };
    expect(countReviewFeedback(record)).toBe(0);
  });

  it("returns 0 for animatic-preview with null decisions", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: null,
    };
    expect(countReviewFeedback(record)).toBe(0);
  });
});

describe("countReviewAssets", () => {
  it("sums variant counts across shots", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", start: 0, duration: 3, variants: { key: "v-a", wide: "v-b" } },
          { shotId: "02", start: 3, duration: 2, variants: { key: "v-c" } },
        ],
      },
      decisions: [],
    };
    expect(countReviewAssets(record)).toBe(3);
  });

  it("returns 0 when there are no shots", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
    };
    expect(countReviewAssets(record)).toBe(0);
  });
});

describe("formatReviewRecord", () => {
  // An animatic review is a reel review, so its decisions are per shot and expand into the
  // addresses each shot signed off — the same vocabulary the video's record uses.
  it("renders animatic-preview decisions per shot, under the animatic stage", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "03", start: 0, duration: 4, variants: { first: "v-Q4nT8aLp" } }],
      },
      decisions: { "03": "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Review: animatic-preview (animatic) 2026-05-16T12:00:00.000Z");
    expect(out).toContain("Accepted:");
    expect(out).toContain("animatic:shot.03.first (v-Q4nT8aLp)");
  });

  it("omits carried-over stale feedback, keeping one that went stale within its own submit", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          variantId: "v-xm65f1Aa",
          status: "accepted",
          feedback: [
            { id: "fb-Qv1pNz65", annotation: null, text: "carried over", stale: true },
            { id: "fb-27aTaC02", annotation: null, text: "written now", stale: true, added: true },
          ],
        },
        {
          address: "reference:dog",
          feedback: [{ id: "fb-8kLmR3wq", annotation: null, text: "all stale here", stale: true }],
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).not.toContain("carried over");
    expect(out).toContain("[fb-27aTaC02] written now [added] [stale]");
    // The address whose only comment was carried over drops out of the section entirely.
    expect(out).not.toContain("reference:dog");
  });

  it("names the take each comment was written against", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          feedback: [
            {
              id: "fb-Qv1pNz65",
              annotation: null,
              text: "ears too long",
              displayedVariants: { "reference:cat": "v-xm65f1Aa" },
              stale: false,
            },
          ],
        },
      ],
    };

    // The comment stands on the address holding the take, so the take is named bare.
    expect(formatReviewRecord(record)).toContain("[fb-Qv1pNz65] ears too long [saw: v-xm65f1Aa]");
  });

  it("names every take under a note whose subject spans more than its own address", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "02", start: 0, duration: 3, variants: { motion: "v-Q4nT8aLp" } }],
      },
      decisions: {},
      notes: [
        {
          id: "fb-8kLmR3wq",
          time: 1.5,
          shotId: "02",
          address: "video:shot.02#composition",
          text: "too dark",
          displayedVariants: {
            "video:shot.02.motion": "v-Q4nT8aLp",
            "animatic:shot.02.first": "v-UI5zkvU6",
          },
        },
      ],
    };

    expect(formatReviewRecord(record)).toContain(
      "too dark [saw: animatic:shot.02.first=v-UI5zkvU6, video:shot.02.motion=v-Q4nT8aLp]",
    );
  });

  it("renders a comment with no snapshotted take unchanged", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "direction:brief.logline",
          feedback: [{ id: "fb-Qv1pNz65", annotation: null, text: "weak hook", stale: false }],
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("[fb-Qv1pNz65] weak hook");
    expect(out).not.toContain("saw:");
  });

  it("renders video-preview accepts with variant IDs and un-accepts under Accept withdrawn", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", start: 0, duration: 3, variants: { motion: "v-UI5zkvU6" } },
          { shotId: "02", start: 3, duration: 3, variants: { motion: "v-Q4nT8aLp" } },
        ],
      },
      decisions: { "01": "accepted", "02": "none" },
      notes: [
        {
          time: 5.2,
          shotId: "02",
          address: "video:shot.02#composition",
          x: 0.5,
          y: 0.5,
          text: "too dark",
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:");
    expect(out).toContain("video:shot.01.motion (v-UI5zkvU6)");
    // An explicit un-accept ("none") is its own outcome, listed under Accept withdrawn by bare address.
    expect(out).toContain("Accept withdrawn:");
    expect(out).toContain("  video:shot.02.motion");
    // Feedback is grouped under the target address, not the old flat `Notes:` block.
    expect(out).toContain("Feedback:");
    expect(out).toContain("  video:shot.02#composition");
    expect(out).toContain("    5.2s (shot.02 +2.2s) (pin: 0.50, 0.50) too dark");
    expect(out).not.toContain("Notes:");
    expect(out).not.toContain("File:");
  });

  it("reports a feedback-only review with no decisions as none submitted", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "03", start: 0, duration: 3, variants: { motion: "v-UI5zkvU6" } }],
      },
      decisions: {},
      notes: [
        {
          time: 8.2,
          shotId: "03",
          address: "video:shot.03#composition",
          text: "全体的に文字が小さい",
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: none submitted");
    expect(out).not.toContain("Accept withdrawn:");
    expect(out).toContain("Feedback:");
    expect(out).toContain("  video:shot.03#composition");
    expect(out).toContain("    8.2s (shot.03 +8.2s) 全体的に文字が小さい");
  });

  it("renders timeline video assets, accepted only when every shot is accepted", () => {
    const base = {
      mode: "video-preview" as const,
      stage: "video" as const,
      createdAt: "2026-05-16T12:00:00.000Z",
    };
    const context = {
      shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
      timeline: { bgm: "v-bbbbbbbb" },
    };

    const accepted = formatReviewRecord({ ...base, context, decisions: { "01": "accepted" } });
    expect(accepted).toContain("video:timeline.bgm (v-bbbbbbbb)");

    // A shot that isn't explicitly accepted means submit never accepts the timeline
    // asset, so it must not be listed as accepted (the shot itself surfaces under Accept withdrawn).
    const notOk = formatReviewRecord({ ...base, context, decisions: { "01": "none" } });
    expect(notOk).not.toContain("video:timeline.bgm");
    expect(notOk).toContain("Accept withdrawn:");

    // An undecided shot is likewise not "accepted", so timeline stays out of the accept list.
    const undecided = formatReviewRecord({ ...base, context, decisions: {} });
    expect(undecided).not.toContain("video:timeline.bgm");
  });

  it("names an accepted shot's own takes and the timeline's, and the upstream ones apart", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          {
            shotId: "01",
            start: 0,
            duration: 3,
            variants: { first: "v-eeeeeeee", motion: "v-aaaaaaaa" },
            sources: {
              "video:shot.01.motion": "v-aaaaaaaa",
              "animatic:shot.01.line": "v-cccccccc",
            },
          },
        ],
        timeline: { bgm: "v-bbbbbbbb" },
        timelineSources: { "video:timeline.bgm": "v-bbbbbbbb", "reference:theme": "v-dddddddd" },
      },
      decisions: { "01": "accepted" },
      timelineStemDecision: "accepted",
    };

    const out = formatReviewRecord(record);
    expect(out).toContain(
      [
        "Accepted: 1 of 1 shot (01), video:timeline#stem",
        "  video:shot.01.motion (v-aaaaaaaa)",
        "  video:timeline.bgm (v-bbbbbbbb)",
        "",
        "Upstream takes seen or heard:",
        "  animatic:shot.01.line (v-cccccccc) — in shot.01",
        "  reference:theme (v-dddddddd) — in timeline#stem",
      ].join("\n"),
    );
    expect(out).not.toContain("video:shot.01.first");
  });

  it("names an upstream take two accepted shots share once, and one accepted as its own not at all", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          {
            shotId: "30",
            start: 0,
            duration: 3,
            variants: { screen: "v-30aaaaaa" },
            sources: {
              "animatic:shot.28.screen": "v-28aaaaaa",
              "animatic:shot.30.screen": "v-30aaaaaa",
            },
          },
          {
            shotId: "34",
            start: 3,
            duration: 3,
            variants: { line: "v-34aaaaaa" },
            sources: {
              "animatic:shot.28.screen": "v-28aaaaaa",
              "animatic:shot.30.screen": "v-30aaaaaa",
              "animatic:shot.34.line": "v-34aaaaaa",
              "reference:flyer": "v-ffffffff",
            },
          },
        ],
      },
      decisions: { "30": "accepted", "34": "accepted" },
      cascadeAccepted: [{ address: "reference:flyer", via: "animatic:shot.34#stem" }],
    };

    expect(formatReviewRecord(record)).toContain(
      [
        "Accepted: 2 of 2 shots (30–34)",
        "  animatic:shot.30.screen (v-30aaaaaa)",
        "  animatic:shot.34.line (v-34aaaaaa)",
        "",
        "Upstream takes seen or heard:",
        "  animatic:shot.28.screen (v-28aaaaaa) — in shot.30, shot.34",
        "  reference:flyer (v-ffffffff) — in shot.34, accepted via animatic:shot.34#stem",
      ].join("\n"),
    );
  });

  it("names a shot composed only from upstream takes as composition only", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          {
            shotId: "27",
            start: 0,
            duration: 3,
            variants: {},
            sources: { "animatic:shot.27.screen": "v-27aaaaaa" },
          },
        ],
        contentHashes: { "video:shot.27#composition": "h-27" },
      },
      decisions: { "27": "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: 1 of 1 shot (27)\n  video:shot.27 (composition only)");
    expect(out).toContain("  animatic:shot.27.screen (v-27aaaaaa) — in shot.27");
  });

  it("names the beds a timeline stem accept heard while a shot is left undecided", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
        timeline: { bgm: "v-bbbbbbbb", logo: "v-eeeeeeee" },
        timelineSources: { "video:timeline.bgm": "v-bbbbbbbb" },
      },
      decisions: {},
      timelineStemDecision: "accepted",
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: video:timeline#stem\n  video:timeline.bgm (v-bbbbbbbb)");
    expect(out).not.toContain("video:timeline.logo");
  });

  it("names every take an un-accept released, the ones only another consumed included", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          {
            shotId: "01",
            start: 0,
            duration: 3,
            variants: { first: "v-eeeeeeee", motion: "v-aaaaaaaa" },
            sources: { "video:shot.01.motion": "v-aaaaaaaa" },
          },
        ],
      },
      decisions: { "01": "none" },
    };

    expect(formatReviewRecord(record)).toContain(
      [
        "Accept withdrawn: 1 of 1 shot (01)",
        "  video:shot.01.first (v-eeeeeeee)",
        "  video:shot.01.motion (v-aaaaaaaa)",
      ].join("\n"),
    );
  });

  it("has no cascade lines when nothing was signed off in context", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
      },
      decisions: { "01": "accepted" },
    };
    const out = formatReviewRecord(record);
    expect(out).toContain("video:shot.01.motion (v-aaaaaaaa)");
    expect(out).not.toContain("(via ");
  });

  it("counts timeline assets toward the review asset total", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
        timeline: { bgm: "v-bbbbbbbb" },
      },
      decisions: { "01": "accepted" },
    };
    expect(countReviewAssets(record)).toBe(2);
  });

  it("prints the File line when a filePath is passed", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-UI5zkvU6" } }],
      },
      decisions: { "01": "none" },
    };

    const out = formatReviewRecord(record, {
      filePath: "review/video/records/20260516T120000000.json",
    });
    expect(out).toContain("File: review/video/records/20260516T120000000.json");
    // The un-accept comes from the record itself, listed by bare address.
    expect(out).toContain("Accept withdrawn:");
    expect(out).toContain("  video:shot.01.motion");
  });

  it("leaves out what a shot accept signed off along with its takes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "05", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
      },
      decisions: { "05": "accepted" },
      cascadeAccepted: [
        { address: "video:shot.05#composition", via: "video:shot.05" },
        { address: "video:shot.05#stem", via: "video:shot.05" },
        { address: "reference:cat-sheet", via: "video:shot.05.motion" },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: 1 of 1 shot (05)\n  video:shot.05.motion (v-aaaaaaaa)");
    expect(out).not.toContain("#composition");
    expect(out).not.toContain("#stem");
    expect(out).not.toContain("reference:cat-sheet");
  });

  it("says why a shot that generates nothing of its own carries no variant id", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", start: 0, duration: 3, variants: {} },
          { shotId: "10", start: 3, duration: 3, variants: { motion: "v-kVNK2f5s" } },
        ],
        contentHashes: { "video:shot.01#composition": "h-01" },
      },
      decisions: { "01": "accepted", "10": "accepted" },
    };

    // Beside a sibling that names its variant, a bare `video:shot.01` reads as a half-recorded
    // accept — the reason keeps it from being mistaken for one.
    const out = formatReviewRecord(record);
    expect(out).toContain("  video:shot.10.motion (v-kVNK2f5s)");
    expect(out).toContain("  video:shot.01 (composition only)");
  });

  it("reports an undeveloped shot, which has no composition either, as generating nothing", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "04", start: 0, duration: 3, variants: {} }] },
      decisions: { "04": "none" },
    };

    expect(formatReviewRecord(record)).toContain("  video:shot.04 (no generated assets)");
  });

  it("names a reel review's decided shots per outcome, then their takes in timeline order", () => {
    const shot = (shotId: string, start: number) => ({
      shotId,
      start,
      duration: 1,
      variants: { motion: `v-${shotId}aaaaaa` },
    });
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: ["01", "02", "03", "04", "05", "06"].map((id, i) => shot(id, i)) },
      decisions: { "05": "accepted", "01": "accepted", "02": "accepted", "04": "none" },
      timelineStemDecision: "accepted",
      cascadeAccepted: [
        { address: "video:shot.01#composition", via: "video:shot.01" },
        { address: "reference:bgm", via: "video:timeline#stem" },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain(
      [
        "Accepted: 3 of 6 shots (01–02, 05), video:timeline#stem",
        "  video:shot.01.motion (v-01aaaaaa)",
        "  video:shot.02.motion (v-02aaaaaa)",
        "  video:shot.05.motion (v-05aaaaaa)",
        "Accept withdrawn: 1 of 6 shots (04)",
        "  video:shot.04.motion (v-04aaaaaa)",
      ].join("\n"),
    );
    expect(out).not.toContain("#composition");
    expect(out).not.toContain("reference:bgm");
  });

  it("leaves a direct accept listed and its cascades out", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        { address: "reference:cat", variantId: "v-xm65f1Aa", status: "accepted", feedback: [] },
      ],
      cascadeAccepted: [{ address: "reference:cat-sheet", via: "reference:cat" }],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:\n  reference:cat (v-xm65f1Aa)");
    expect(out).not.toContain("reference:cat-sheet");
  });

  it("gates the AI-authored handoff behind showHandoff", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", start: 0, duration: 3, variants: { motion: "v-aaaaaaaa" } }],
      },
      decisions: { "01": "accepted" },
      handoffSummary: "remaining shots wrapped up",
      handoffNotes: [{ address: "video:shot.01", text: "confirm the pacing" }],
    };

    // A bare recap is the human's decisions, not the agent's own note echoed back.
    const bare = formatReviewRecord(record);
    expect(bare).not.toContain("Handoff:");
    expect(bare).not.toContain("remaining shots wrapped up");

    const verbose = formatReviewRecord(record, { showHandoff: true });
    expect(verbose).toContain("Handoff:");
    expect(verbose).toContain("  summary: remaining shots wrapped up");
    expect(verbose).toContain("  video:shot.01: confirm the pacing");
  });

  it("derives the stage for the header when the record omits it", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Review: video-preview (video) 2026-05-16T12:00:00.000Z");
  });

  it("names the frame the caller resolved for a note, and nothing for one it did not", () => {
    const image = ".konte/cache/thumbnails/video/shot.01/fb-1/abc123/at-00001000ms.jpg";
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
      notes: [
        { id: "fb-1", time: 1, shotId: "01", address: "video:shot.01", text: "here" },
        {
          id: "fb-2",
          time: 2,
          shotId: "01",
          address: "video:shot.01",
          text: "no frame for this one",
        },
      ],
    };

    const out = formatReviewRecord(record, { noteFrames: new Map([["fb-1", image]]) });
    expect(out).toContain(`[image: ${image}]`);
    expect(out).toContain("[fb-2] 2s no frame for this one");
    expect(out.match(/\[image: /g)).toHaveLength(1);
  });
});

describe("formatReviewRecord note ids", () => {
  it("names the comment a note was stored as, so the listing pairs with a sheet cell", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", start: 0, duration: 3, variants: {} }] },
      decisions: {},
      notes: [
        {
          id: "fb-24G1HFL3",
          time: 1.5,
          shotId: "01",
          address: "video:shot.01",
          text: "face is wrong",
        },
      ],
    };

    expect(formatReviewRecord(record)).toContain(
      "    [fb-24G1HFL3] 1.5s (shot.01 +1.5s) face is wrong",
    );
  });
});

describe("reviewNoteFrameTargets", () => {
  const record: ReviewRecord = {
    mode: "video-preview",
    stage: "video",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: {
      shots: [
        { shotId: "01", start: 0, duration: 10, variants: {} },
        { shotId: "02", start: 10, duration: 10, variants: {} },
      ],
    },
    decisions: {},
    notes: [
      { id: "fb-late", time: 12.5, shotId: "02", address: "video:shot.02", text: "second" },
      { id: "fb-early", time: 3.5, shotId: "01", address: "video:shot.01", text: "first" },
    ],
  };

  it("returns one target per note, shot-local and in timeline order", () => {
    expect(reviewNoteFrameTargets(record)).toEqual([
      {
        id: "fb-early",
        shotId: "01",
        localTime: 3.5,
        annotation: null,
        label: "fb-early shot.01 +3.5s",
      },
      {
        id: "fb-late",
        shotId: "02",
        localTime: 2.5,
        annotation: null,
        label: "fb-late shot.02 +2.5s",
      },
    ]);
  });

  it("measures a note from the frame-snapped start the reviewer played, not the duration sum", () => {
    const offGrid: ReviewRecord = {
      ...record,
      context: {
        shots: [
          { shotId: "01", start: 0, duration: 91.81, variants: {} },
          { shotId: "02", start: 91.8, duration: 2, variants: {} },
        ],
      },
      notes: [
        { id: "fb-cut", time: 91.8, shotId: "02", address: "video:shot.02", text: "at the cut" },
      ],
    };
    expect(reviewNoteFrameTargets(offGrid)[0]).toMatchObject({
      localTime: 0,
      label: "fb-cut shot.02 +0s",
    });
  });

  it("carries a pinned note's reticle, so the rendered frame is marked", () => {
    const pinned: ReviewRecord = {
      ...record,
      notes: [
        {
          id: "fb-pin",
          time: 1,
          shotId: "01",
          x: 0.25,
          y: 0.75,
          address: "video:shot.01",
          text: "here",
        },
      ],
    };
    expect(reviewNoteFrameTargets(pinned)[0]!.annotation).toEqual({
      kind: "pin",
      x: 0.25,
      y: 0.75,
    });
  });

  it("skips a note with no shot of its own, and one from before ids were stored", () => {
    const skipped: ReviewRecord = {
      ...record,
      notes: [
        { id: "fb-bed", time: 6.25, address: "video", text: "bgm too loud" },
        { time: 2, shotId: "01", address: "video:shot.01", text: "no id" },
      ],
    };
    expect(reviewNoteFrameTargets(skipped)).toEqual([]);
  });

  it("returns nothing for a record with no notes", () => {
    expect(reviewNoteFrameTargets({ ...record, notes: undefined })).toEqual([]);
  });
});

describe("formatReviewRecord (keep or regenerate)", () => {
  const record: ReviewRecord = {
    mode: "animatic-preview",
    stage: "animatic",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: { shots: [] },
    decisions: {},
    kept: ["animatic:shot.13.first"],
    regenerate: ["animatic:shot.14.first", "video:shot.14.motion"],
  };

  it("names what was kept and what is left to regenerate", () => {
    const out = formatReviewRecord(record);
    expect(out).toContain("Kept against newer upstream:\n  animatic:shot.13.first");
    expect(out).toContain(
      "Sent back to regenerate:\n  animatic:shot.14.first\n  video:shot.14.motion",
    );
  });

  it("is worth saving on those answers alone", () => {
    expect(hasFeedback({ ...record, kept: [] })).toBe(true);
  });
});

describe("formatReviewRecord (overturned dismissals)", () => {
  const record: ReviewRecord = {
    mode: "video-preview",
    stage: "video",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: { shots: [] },
    decisions: {},
    overturned: [
      { address: "video:shot.05.motion", variantId: "v-old", displaced: "v-new" },
      { address: "video:shot.06.motion", variantId: "v-back" },
    ],
  };

  it("names each take accepted back and the accept it displaced", () => {
    expect(formatReviewRecord(record)).toContain(
      "Overturned an earlier dismissal:\n  video:shot.05.motion v-old (displacing v-new)\n  video:shot.06.motion v-back",
    );
  });
});
