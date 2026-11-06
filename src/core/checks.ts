// Every check konte runs over the definitions and the takes, registered in one place. Each reads what
// it needs off one context and reports findings; `collectFindings` runs them, drops what has not set
// in yet (`onset`), and hands the rest to a gate or to `status` unjudged.

import {
  type AssetStage,
  type DefinitionLike,
  formatShotAddress,
  formatTimelineOverlayAddress,
  getAssetEntry,
  getStage,
  listAddresses,
  tryParseAddress,
} from "./address.js";
import {
  findAnimaticOverflows,
  findAnimaticSilentTails,
  formatAnimaticOverflow,
  formatSilentTail,
} from "./animatic-overflow.js";
import { compositionClassSubjects } from "./composition-builder.js";
import { type AnimaticSetupState, checkViewAnchors } from "./direction-check.js";
import {
  type SongVariantState,
  type StaleWaiver,
  type StagingStageState,
  checkDirection,
  checkViewNamings,
  directionFindings,
  registryFinding,
} from "./direction.js";
import { directionWaiverKey } from "./direction-findings.js";
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
} from "./graph.js";
import { acceptedIn, listReferenceImageTexts, listViewAnchorGaps } from "./board-analysis.js";
import { findUnheldLandmarks } from "./landmark-held-check.js";
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
import { checkSourceLocators } from "./source-direction.js";
import { findUnmouthedStems } from "./stem-mouth-check.js";
import { type Accepted, signedOffBy, withAwaitingAccept } from "./sign-off.js";
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
  variantStage?: AssetStage;
  animaticSetups?: AnimaticSetupState;
  stagingStage?: StagingStageState;
  songVariant?: SongVariantState;
};

// A direction waiver whose finding is gone.
export type StaleWaiverLine = StaleWaiver;

export function formatStaleWaiverLine(w: StaleWaiverLine): string {
  return w.fixOnly
    ? `[${w.key}] waiver of a finding only a fix clears — remove it, and fix the finding (${w.reason})`
    : `[${w.key}] stale waiver — its finding is gone; remove it (${w.reason})`;
}

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
function stageClassSubjects(
  definition: DefinitionLike,
  stage: AssetStage,
): { images: ClassSubject[]; compositions: ClassSubject[] } {
  const images = listAddresses(definition, stage).flatMap((address) => {
    const entry = getAssetEntry(definition, address);
    return entry.kind === "local" && entry.operation === "render"
      ? [{ label: address, html: entry.inputs.stage as string }]
      : [];
  });
  const compositions =
    stage === "reference" ? [] : compositionClassSubjects(definition as unknown as StageDefinition);
  return { images, compositions };
}

const directionResult = new WeakMap<CheckContext, ReturnType<typeof checkDirection>>();
const acceptedByCtx = new WeakMap<CheckContext, Accepted>();

function acceptedOf(ctx: CheckContext): Accepted {
  let accepted = acceptedByCtx.get(ctx);
  if (!accepted) {
    accepted = acceptedIn(ctx.manager, ctx);
    acceptedByCtx.set(ctx, accepted);
  }
  return accepted;
}

// Each `judgedBy` address accepted as drawn leaves `targets` for `signedOff`, where only a targeted
// spend naming it is held.
export function signOffFinding(f: Finding, accepted: Accepted): Finding {
  const signed = f.judgedBy?.filter(accepted) ?? [];
  if (signed.length === 0 || f.targets === undefined) return f;
  const whole = signed.length === f.judgedBy!.length;
  return {
    ...f,
    message: whole
      ? `${f.message} — accepted as drawn; fix it before drawing it again`
      : withAwaitingAccept(f.message, f.judgedBy, accepted),
    targets: f.targets.filter((address) => !signed.includes(address)),
    signedOff: signed,
  };
}

function directionCheckOf(ctx: CheckContext): ReturnType<typeof checkDirection> | null {
  if (!ctx.direction) return null;
  let result = directionResult.get(ctx);
  if (!result) {
    result = checkDirection(ctx.direction, {
      referenceAssetNames: ctx.reference?.exposedAssetNames ?? [],
      animaticSetups: ctx.animaticSetups,
      stagingStage: ctx.stagingStage,
      songVariant: ctx.songVariant,
      accepted: acceptedOf(ctx),
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
          message: "no `direction.ts` found",
        },
      ];
    }
    return directionFindings(directionCheckOf(ctx)!, ctx.direction).filter(
      (f) => f.code !== "view-unanchored" && f.code !== "view-unnamed",
    );
  },
  staleWaivers: (ctx) => directionCheckOf(ctx)?.staleWaivers ?? [],
};

// Off the reference pool alone, so it holds the reference spend before an animatic exists.
const VIEW_CHECK: Check = {
  codes: ["view-unanchored", "view-unnamed"],
  run: (ctx) => {
    if (!ctx.direction || !ctx.reference) return [];
    const waivers = ctx.direction.waivers ?? {};
    const accepted = acceptedOf(ctx);
    return [
      ...checkViewAnchors(
        listViewAnchorGaps(ctx.reference),
        new Set(ctx.reference.exposedAssetNames ?? []),
      ),
      ...checkViewNamings(ctx.direction, listReferenceImageTexts(ctx.reference)),
    ].flatMap((f): Finding[] => {
      const key = directionWaiverKey(f);
      if (key in waivers || signedOffBy(f.judgedBy, accepted)) return [];
      return [
        registryFinding(f, {
          subject: f.subject ?? "",
          fixIn: { stage: "reference" },
          message: f.message,
          key,
        }),
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

const LANDMARK_HELD_CHECK: Check = {
  codes: ["landmark-unheld"],
  run: (ctx) => {
    const { direction } = ctx;
    if (!direction) return [];
    return (["animatic", "video"] as const).flatMap((stage) => {
      const def = ctx[stage];
      if (!def) return [];
      return findUnheldLandmarks(direction, def.prompts ?? [], def.imageInputs ?? []).map(
        (u): Finding => ({
          code: "landmark-unheld",
          subject: `${u.address} "${u.promptDepiction}"`,
          fixIn: { stage },
          message:
            `"${u.landmarkId}" is not in the \`holds\` of ` +
            `${u.setups.map((s) => `"${s}"`).join(" / ")}`,
          targets: [u.address],
          judgedBy: [u.address],
        }),
      );
    });
  },
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
            message: `font family: ${f.fontFamily.join(", ")}`,
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
          message: `${shot ? `${shot}: ` : ""}no ${u.missing.join(", no ")}; take ${u.variantId}`,
          targets: [u.address],
        };
      },
    );
  },
};

const VARIANT_CHECK: Check = {
  codes: ["take-silent", "line-misheard"],
  run: async (ctx) => {
    if (!ctx.manager || !ctx.lang) return [];
    const found = await unvouchedFindings({
      videoRoot: ctx.videoRoot,
      manager: ctx.manager,
      definitions: { reference: ctx.reference, animatic: ctx.animatic, video: ctx.video },
      direction: ctx.direction,
      lang: ctx.lang,
      ...(ctx.variantStage ? { stage: ctx.variantStage } : {}),
    });
    return found.flatMap((v) =>
      v.findings.map(
        (f): Finding => ({
          code: f.type === "silent" ? "take-silent" : "line-misheard",
          subject: v.variantId,
          fixIn: { stage: getStage(v.address) },
          message: `${v.address} ${f.detail}`,
          targets: [v.address],
        }),
      ),
    );
  },
};

const OVERFLOW_CHECK: Check = {
  codes: ["line-truncated"],
  run: (ctx) => {
    if (!ctx.manager || !ctx.animatic) return [];
    return findAnimaticOverflows(ctx.animatic, ctx.manager).map((o): Finding => {
      const retime = o.retime
        ? ` — retime ${o.retime.src} to duration ${o.retime.roomSec.toFixed(2)} ` +
          `(${o.retime.rate.toFixed(3)}x)`
        : "";
      return {
        code: "line-truncated",
        subject: o.address,
        fixIn: { stage: o.retime ? "animatic" : "direction" },
        message: `${formatAnimaticOverflow(o)}${retime}`,
        targets: [o.address],
      };
    });
  },
};

const SILENT_TAIL_CHECK: Check = {
  codes: ["tail-silent"],
  run: (ctx) => {
    if (!ctx.manager || !ctx.animatic) return [];
    return findAnimaticSilentTails(ctx.animatic, ctx.manager)
      .filter((t) => !t.vouched)
      .map(
        (t): Finding => ({
          code: "tail-silent",
          subject: t.address,
          fixIn: { stage: "animatic" },
          message: `${formatSilentTail(t)}; fit: duration ${t.fitDurationSec}`,
          targets: [t.address],
        }),
      );
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
      subject: formatShotAddress("video", shotId),
      fixIn: { stage: "video", ...(patch ? { patch } : {}) },
      message: `spends without building on ${formatShotAddress("animatic", shotId)}`,
      targets: [formatShotAddress("video", shotId)],
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

const STEM_MOUTH_CHECK: Check = {
  codes: ["stem-unmouthed"],
  run: (ctx) => {
    if (!ctx.direction || !ctx.animatic || !ctx.video) return [];
    return findUnmouthedStems(ctx.direction, ctx.animatic, ctx.video).map(
      (u): Finding => ({
        code: "stem-unmouthed",
        subject: u.address,
        fixIn: { stage: "video" },
        message: `${u.speakers.join(", ")} ${u.speakers.length === 1 ? "is" : "are"} off the frame`,
        targets: [u.address],
        judgedBy: [u.address],
      }),
    );
  },
};

const SUBTITLE_PAUSE_CHECK: Check = {
  codes: ["subtitle-pauses-stale"],
  run: async (ctx) => {
    if (!ctx.manager) return [];
    // Loaded on use: the render it times the lines off imports the loader, which imports this.
    const { staleSubtitlePauses } = await import("./line-timing.js");
    const stale = await staleSubtitlePauses([ctx.animatic, ctx.video], ctx.manager);
    return stale.map((s): Finding => {
      const overlay = formatTimelineOverlayAddress(s.stage);
      return {
        code: "subtitle-pauses-stale",
        subject: overlay,
        fixIn: { stage: s.stage },
        message:
          `line ${s.line} of shot ${s.shotId} splits at the pauses of take ${s.take}; ` +
          (s.now ? `take ${s.now} says it now` : "no take says it now"),
        targets: [overlay],
      };
    });
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
        message: `built on ${refs.join(", ")}`,
        targets: [from],
      }),
    );
  },
};

// A source locator past the chunks of its original.
const SOURCE_LOCATOR_CHECK: Check = {
  codes: ["source-locator-out-of-range"],
  run: (ctx) => (ctx.direction ? checkSourceLocators(ctx.direction, ctx.videoRoot) : []),
};

const CHECKS: readonly Check[] = [
  DIRECTION_CHECK,
  SOURCE_LOCATOR_CHECK,
  VIEW_CHECK,
  PROMPT_CHECK,
  LANDMARK_HELD_CHECK,
  PIN_CHECK,
  CLASS_CHECK,
  MOVEMENT_CHECK,
  VARIANT_CHECK,
  OVERFLOW_CHECK,
  SILENT_TAIL_CHECK,
  ANIMATIC_CONSUMED_CHECK,
  STEM_MOUTH_CHECK,
  SUBTITLE_PAUSE_CHECK,
  BUILD_CHECK,
  PENDING_REFERENCE_CHECK,
];

function reportsAny(check: Check, want: (traits: FindingTraits) => boolean): boolean {
  return check.codes.some((code) => want(findingTraits(code)));
}

// Every finding the checks report that has set in. `want` narrows the run to the checks reporting a
// code it cares about — an accept needs no take heard. `signedOff` keeps a finding every address of
// which an accept signed off, for the spend gate to hold a targeted spend naming one.
export async function collectFindings(
  ctx: CheckContext,
  want: (traits: FindingTraits) => boolean = () => true,
  opts: { signedOff?: boolean } = {},
): Promise<FindingReport> {
  const findings: Finding[] = [];
  const staleWaivers: StaleWaiverLine[] = [];
  for (const check of CHECKS) {
    if (!reportsAny(check, want)) continue;
    for (const raw of await check.run(ctx)) {
      const traits = findingTraits(raw.code);
      if (!want(traits)) continue;
      if (traits.onset === "after-direction-accepted" && !ctx.directionAccepted) continue;
      const f = signOffFinding(raw, acceptedOf(ctx));
      if (f.targets?.length === 0 && f.signedOff && !opts.signedOff) continue;
      findings.push(f);
    }
    staleWaivers.push(...(check.staleWaivers?.(ctx) ?? []));
  }
  return { findings, staleWaivers };
}
