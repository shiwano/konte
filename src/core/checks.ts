// Every check konte runs over the definitions and the takes, registered in one place. Each reads what
// it needs off one context and reports findings; `collectFindings` runs them, drops what has not set
// in yet (`onset`), and hands the rest to a gate or to `status` unjudged.

import {
  type AssetStage,
  type DefinitionLike,
  getAssetEntryByAddress,
  getStage,
  listAssetPaths,
  tryParseAddress,
} from "./address.js";
import { findAnimaticOverflows, formatAnimaticOverflow } from "./animatic-overflow.js";
import { compositionClassSubjects } from "./composition-builder.js";
import { type AnimaticSetupState, checkViewAnchors } from "./direction-check.js";
import {
  type SongTakeState,
  type StaleWaiver,
  type StagingStageState,
  checkDirection,
  directionFindings,
  directionWaiverKey,
} from "./direction.js";
import type { Direction } from "./dsl/direction.js";
import {
  DIRECTION_FINDING_CODES,
  type Finding,
  type FindingCode,
  type FindingTraits,
  findingTraits,
} from "./finding.js";
import {
  type DependencyGraph,
  collectTransitiveDependents,
  listBoardlessVideoShots,
  listViewAnchorGaps,
} from "./graph.js";
import { type PinOccurrence, pinFindings } from "./pin-check.js";
import { type PromptOccurrence, promptFindings } from "./prompt-check.js";
import { findAllUnmetPrerequisites, prerequisiteShot } from "./review-prerequisites.js";
import type { StateManager } from "./state/index.js";
import { type ClassSubject, checkTailwindClasses } from "./tailwind-classes.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  ReferenceDefinition,
  StageDefinition,
  VideoDefinition,
} from "./types/index.js";
import { isVendorBackendAsset } from "./vendor-backend.js";
import { unvouchedFindings } from "./variant-check.js";

// The prompts and pins one outstanding patch script would spend on, and its steps.
export type PatchSubject = {
  sourceVariantId: string;
  sourceAddress: string;
  prompts?: readonly PromptOccurrence[];
  pins?: readonly PinOccurrence[];
  assets?: Readonly<Record<string, AssetDefinition>>;
};

// What the checks read. A stage that could not be read is null; a direction-check input that could
// not be read is undefined, which leaves the findings it feeds unevaluated.
export type CheckContext = {
  videoRoot: string;
  // null: no direction.ts at all; a broken one never reaches a context.
  direction: Direction | null;
  directionAccepted: boolean;
  reference: ReferenceDefinition | null;
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
  manager: StateManager | null;
  graph: DependencyGraph | null;
  patches: readonly PatchSubject[];
  // The language the piece's lines are heard in.
  lang: string | null;
  // The one stage whose takes are heard; absent, every stage's.
  takeStage?: AssetStage;
  animaticSetups?: AnimaticSetupState;
  stagingStage?: StagingStageState;
  songTake?: SongTakeState;
};

// A direction waiver whose finding is gone.
export type StaleWaiverLine = StaleWaiver;

export type FindingReport = {
  findings: Finding[];
  staleWaivers: StaleWaiverLine[];
};

type Check = {
  codes: readonly FindingCode[];
  run: (ctx: CheckContext) => Finding[] | Promise<Finding[]>;
  // The direction check also reports the waivers that cancel nothing.
  staleWaivers?: (ctx: CheckContext) => StaleWaiverLine[];
};

const ASSET_STAGES: readonly AssetStage[] = ["reference", "animatic", "video"];

function stageDefinitions(ctx: CheckContext): Array<[AssetStage, DefinitionLike]> {
  return ASSET_STAGES.flatMap((stage) => {
    const def = ctx[stage];
    return def ? [[stage, def as DefinitionLike] as [AssetStage, DefinitionLike]] : [];
  });
}

// The markup the class check reads on a stage: each `jsxImage`'s, and on a composition stage each
// developed shot's composition and the overlay — which a review renders too.
export function stageClassSubjects(
  definition: DefinitionLike,
  stage: AssetStage,
): { images: ClassSubject[]; compositions: ClassSubject[] } {
  const images = listAssetPaths(definition, stage).flatMap((address) => {
    const entry = getAssetEntryByAddress(definition, address);
    return entry.kind === "local" && entry.operation === "render"
      ? [{ label: address, html: entry.inputs.stage as string }]
      : [];
  });
  const compositions =
    stage === "reference" ? [] : compositionClassSubjects(definition as unknown as StageDefinition);
  return { images, compositions };
}

const directionResult = new WeakMap<CheckContext, ReturnType<typeof checkDirection>>();

function directionCheckOf(ctx: CheckContext): ReturnType<typeof checkDirection> | null {
  if (!ctx.direction) return null;
  let result = directionResult.get(ctx);
  if (!result) {
    result = checkDirection(ctx.direction, {
      referenceAssetNames: ctx.reference?.exposedAssetNames ?? [],
      animaticSetups: ctx.animaticSetups,
      stagingStage: ctx.stagingStage,
      songTake: ctx.songTake,
    });
    directionResult.set(ctx, result);
  }
  return result;
}

const DIRECTION_CHECK: Check = {
  // Every structural error shares the traits of `direction-missing`.
  codes: [...DIRECTION_FINDING_CODES, "direction-missing"],
  run: (ctx) => {
    if (!ctx.direction) {
      return [
        {
          code: "direction-missing",
          subject: "",
          fixIn: { stage: "direction" },
          message: "No direction.ts found — declare the video's direction (lens + shots)",
        },
      ];
    }
    return directionFindings(directionCheckOf(ctx)!, ctx.direction).filter(
      (f) => f.code !== "view-unanchored",
    );
  },
  staleWaivers: (ctx) => directionCheckOf(ctx)?.staleWaivers ?? [],
};

// Off the reference pool alone, so it holds the reference spend before an animatic exists.
const VIEW_ANCHOR_CHECK: Check = {
  codes: ["view-unanchored"],
  run: (ctx) => {
    if (!ctx.direction || !ctx.reference) return [];
    const waivers = ctx.direction.waivers ?? {};
    return checkViewAnchors(
      listViewAnchorGaps(ctx.reference),
      new Set(ctx.reference.exposedAssetNames ?? []),
    ).flatMap((f): Finding[] => {
      const key = directionWaiverKey(f);
      if (key in waivers) return [];
      return [
        {
          code: f.code,
          subject: f.subject ?? "",
          fixIn: { stage: "reference" },
          message: f.message,
          key,
        },
      ];
    });
  },
};

const PROMPT_CHECK: Check = {
  codes: ["prompt-negation", "prompt-not-yet", "prompt-double-negative"],
  run: (ctx) => [
    ...stageDefinitions(ctx).flatMap(([stage, def]) =>
      promptFindings(def as { prompts?: readonly PromptOccurrence[] }, { stage }),
    ),
    ...ctx.patches.flatMap((p) =>
      promptFindings(p, { stage: getStage(p.sourceAddress), patch: p.sourceVariantId }),
    ),
  ],
};

const PIN_CHECK: Check = {
  codes: ["pin-unanchored"],
  run: (ctx) => [
    ...stageDefinitions(ctx).flatMap(([stage, def]) =>
      pinFindings(def as { pins?: readonly PinOccurrence[] }, { stage }),
    ),
    ...ctx.patches.flatMap((p) =>
      pinFindings(p, { stage: getStage(p.sourceAddress), patch: p.sourceVariantId }),
    ),
  ],
};

const CLASS_CHECK: Check = {
  codes: ["class-font-family", "composition-class-font-family"],
  run: async (ctx) => {
    const out: Finding[] = [];
    for (const [stage, def] of stageDefinitions(ctx)) {
      const { images, compositions } = stageClassSubjects(def, stage);
      for (const [code, subjects] of [
        ["class-font-family", images],
        ["composition-class-font-family", compositions],
      ] as const) {
        for (const f of await checkTailwindClasses(subjects)) {
          out.push({
            code,
            subject: f.label,
            fixIn: { stage },
            message:
              `font family: ${f.fontFamily.join(", ")} — declare it on direction.policy.fonts; ` +
              "the export embeds faces by reading the HTML, and a class's CSS does not exist until " +
              "the browser has run",
            targets: [f.label],
          });
        }
      }
    }
    return out;
  },
};

const MOVEMENT_CHECK: Check = {
  codes: ["movement-unwritten"],
  run: (ctx) => {
    if (!ctx.manager || !ctx.animatic) return [];
    return findAllUnmetPrerequisites({ animatic: ctx.animatic }, ctx.manager.getState()).map(
      (u) => {
        const shot = prerequisiteShot(u);
        return {
          code: "movement-unwritten",
          subject: u.address,
          fixIn: { stage: u.stage },
          message:
            `${shot ? `${shot}: ` : ""}no ${u.missing.join(", no ")} — write ${u.missing.join("/")} ` +
            `from the output of ${u.variantId}`,
          targets: [u.address],
        };
      },
    );
  },
};

const VARIANT_CHECK: Check = {
  codes: ["take-silent", "line-misheard"],
  run: (ctx) => {
    if (!ctx.manager || !ctx.lang) return [];
    const found = unvouchedFindings({
      videoRoot: ctx.videoRoot,
      manager: ctx.manager,
      definitions: { reference: ctx.reference, animatic: ctx.animatic, video: ctx.video },
      lang: ctx.lang,
      ...(ctx.takeStage ? { stage: ctx.takeStage } : {}),
    });
    return found.flatMap((v) =>
      v.findings.map(
        (f): Finding => ({
          code: f.type === "silent" ? "take-silent" : "line-misheard",
          subject: v.variantId,
          fixIn: { stage: getStage(v.address) },
          message:
            `${v.address} ${f.detail} — dismiss it (reroll for another beside it), or ` +
            `\`konte vouch ${v.variantId}\` once you have heard it is fine`,
          targets: [v.address],
        }),
      ),
    );
  },
};

const OVERFLOW_CHECK: Check = {
  codes: ["narration-overflow"],
  run: (ctx) => {
    if (!ctx.manager || !ctx.animatic) return [];
    return findAnimaticOverflows(ctx.animatic, ctx.manager).map((o): Finding => {
      const fix = o.retime
        ? `put ${o.retime.src} through adapters.audioRetime with duration ` +
          `${o.retime.roomSec.toFixed(2)} (${o.retime.rate.toFixed(3)}x) and play that in its place`
        : `lengthen shot ${o.shotId}'s duration or shorten its script`;
      return {
        code: "narration-overflow",
        subject: o.address,
        fixIn: { stage: o.retime ? "animatic" : "direction" },
        message: `${formatAnimaticOverflow(o)} — ${fix}`,
        targets: [o.address],
      };
    });
  },
};

// A shot whose definition spends holds the stage; one that spends only through a patch's own steps
// holds that patch.
const ANIMATIC_CONSUMED_CHECK: Check = {
  codes: ["animatic-unconsumed"],
  run: (ctx) => {
    if (!ctx.video || !ctx.animatic || !ctx.graph) return [];
    const boardless = listBoardlessVideoShots(ctx.video, ctx.animatic, ctx.graph);
    const finding = (shotId: string, patch?: string): Finding => ({
      code: "animatic-unconsumed",
      subject: `video:shot.${shotId}`,
      fixIn: { stage: "video", ...(patch ? { patch } : {}) },
      message:
        `spends without building on animatic:shot.${shotId} — build it from its own board shot ` +
        "(a panel image, `.stem` — not `.narrationStem`, which builds nothing) in video.tsx, " +
        `developing that board shot first if it is still a pendingShot, or leave it as ` +
        `pendingShot("${shotId}") until it is wired`,
      targets: [`video:shot.${shotId}`],
    });
    return [
      ...boardless.filter((s) => s.spends).map((s) => finding(s.shotId)),
      ...ctx.patches.flatMap((p) => {
        if (getStage(p.sourceAddress) !== "video") return [];
        const spends = Object.values(p.assets ?? {}).some((def) => isVendorBackendAsset(def.kind));
        if (!spends) return [];
        // The shots the patched take plays in: its own, or every shot drawing a timeline asset.
        const shotIds = new Set(
          [p.sourceAddress, ...collectTransitiveDependents(ctx.graph!, p.sourceAddress)].flatMap(
            (address) => {
              const parsed = tryParseAddress(address);
              return parsed?.stage === "video" && parsed.kind === "shot" ? [parsed.shotId] : [];
            },
          ),
        );
        return boardless
          .filter((s) => !s.spends && shotIds.has(s.shotId))
          .map((s) => finding(s.shotId, p.sourceVariantId));
      }),
    ];
  },
};

// What a stage build found of itself instead of refusing to load.
const BUILD_CHECK: Check = {
  codes: [
    "script-unvoiced",
    "cutin-required",
    "cutin-undeclared",
    "plate-undeclared-setup",
    "soundtrack-anchor-unknown",
  ],
  run: (ctx) =>
    [ctx.animatic, ctx.video].flatMap((def) =>
      (def?.buildFindings ?? []).map((f): Finding => ({ ...f, fixIn: { stage: def!.stage } })),
    ),
};

// An asset built on a shot that is still a pendingShot: it waits for that shot, the rest spends.
const PENDING_REFERENCE_CHECK: Check = {
  codes: ["pending-reference"],
  run: (ctx) => {
    const refsByAsset = new Map<string, string[]>();
    for (const { from, ref } of ctx.graph?.pendingReferences ?? []) {
      refsByAsset.set(from, [...(refsByAsset.get(from) ?? []), ref]);
    }
    return [...refsByAsset].map(
      ([from, refs]): Finding => ({
        code: "pending-reference",
        subject: from,
        fixIn: { stage: getStage(from) },
        message:
          `is built on ${refs.join(", ")}, of a shot still a pendingShot — it and what is built on ` +
          "it wait until that shot is developed; the rest of the stage spends",
        targets: [from],
      }),
    );
  },
};

const CHECKS: readonly Check[] = [
  DIRECTION_CHECK,
  VIEW_ANCHOR_CHECK,
  PROMPT_CHECK,
  PIN_CHECK,
  CLASS_CHECK,
  MOVEMENT_CHECK,
  VARIANT_CHECK,
  OVERFLOW_CHECK,
  ANIMATIC_CONSUMED_CHECK,
  BUILD_CHECK,
  PENDING_REFERENCE_CHECK,
];

function reportsAny(check: Check, want: (traits: FindingTraits) => boolean): boolean {
  return check.codes.some((code) => want(findingTraits(code)));
}

// Every finding the checks report that has set in. `want` narrows the run to the checks reporting a
// code it cares about — an accept needs no take heard.
export async function collectFindings(
  ctx: CheckContext,
  want: (traits: FindingTraits) => boolean = () => true,
): Promise<FindingReport> {
  const findings: Finding[] = [];
  const staleWaivers: StaleWaiverLine[] = [];
  for (const check of CHECKS) {
    if (!reportsAny(check, want)) continue;
    for (const f of await check.run(ctx)) {
      const traits = findingTraits(f.code);
      if (!want(traits)) continue;
      if (traits.onset === "after-direction-accepted" && !ctx.directionAccepted) continue;
      findings.push(f);
    }
    staleWaivers.push(...(check.staleWaivers?.(ctx) ?? []));
  }
  return { findings, staleWaivers };
}
