import { ratioOf } from "../../../core/aspect.js";
import {
  DIRECTION_BRIEF_FIELDS,
  DIRECTION_NARRATOR_ADDRESS,
  DIRECTION_ROOT_PATH,
  type DirectionSection,
  directionChildNodePath,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionSetupAddress,
  formatDirectionPropAddress,
  formatDirectionSequenceAddress,
  formatDirectionShotAddress,
  formatDirectionBriefAddress,
  formatDirectionPolicyAddress,
  formatDirectionWaiverAddress,
  isDirectionBriefListField,
} from "../../../core/address.js";
import { errorResponse, jsonResponse, parseJsonBody } from "../../page-host/http.js";
import { loadAnimaticSetupState, loadStagingStageState } from "../../load-definition.js";
import {
  checkDirection,
  directionWaiverEntries,
  directionWaiverKey,
  resolveLens,
} from "../../../core/direction.js";
import { BEAT_FUNCTION_LABEL, PLEASURE_GLOSS } from "../../../core/lenses.js";
import { directionHash, directionPartHashes } from "../../../core/direction-hash.js";
import {
  type DirectionAcceptanceSummary,
  type DirectionSectionDecisions,
  type DirectionSectionStatus,
  applyDirectionSectionDecisions,
  directionAcceptanceView,
  directionGatingSections,
  summarizeDirectionAcceptance,
} from "../../../core/direction-acceptance.js";
import type {
  Direction,
  DirectionBrief,
  DirectionNode,
  Pleasure,
  Shot,
} from "../../../core/dsl/direction.js";
import { isAsideShot, isGraphicShot, resolveDirectionFormat } from "../../../core/dsl/direction.js";
import type { BeatFunction } from "../../../core/direction-check.js";
import type {
  DirectionPolicyFieldInfo,
  DirectionSequenceInfo,
  DirectionVoiceInfo,
} from "../../../pages/preview/types.js";
import { scriptLinesToView } from "../../../core/types/script.js";
import type { Handoff, ReferenceDefinition } from "../../../core/types/index.js";
import {
  type ReviewDecisionEntry,
  type ReviewRecord,
  saveReviewRecord,
} from "../../../core/review-record.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import {
  buildAddressFeedback,
  shotFrameResolver,
  isValidSubmitPayload,
  applyFeedbackMutations,
  staleFlagsBeforeDecisions,
  recordFeedbackFor,
  handoffRecordFields,
} from "./review-shared.js";
import { type ReportOutcome, emptyOutcome } from "./review-outcome.js";

// A direction part's feedback address is `direction:<part>`, the same form a handoff note carries.
function handoffNoteForDirection(handoff: Handoff | null, address: string): string | undefined {
  return (handoff?.notes ?? []).find((n) => n.address === address)?.text;
}

// The direction as a media-less review view: the arc (lens/pleasure), every shot and
// (long-form) sequence with its role/synopsis/duration, the characters, the live structural findings
// from `checkDirection`, and whether the current direction is still the accepted one.
// Feedback attaches to a synthetic address per reviewable part (`direction:<part>`).
export async function handleGetDirectionState(
  videoRoot: string,
  direction: Direction,
  reference: ReferenceDefinition | null,
  handoff: Handoff | null,
): Promise<Response> {
  const manager = await StateManager.load(videoRoot);
  const feedbackMgr = await FeedbackManager.load(videoRoot, "direction");
  const state = manager.getState();

  const check = checkDirection(direction, {
    referenceAssetNames: reference?.exposedAssetNames ?? [],
    animaticSetups: await loadAnimaticSetupState(videoRoot, direction),
    stagingStage: await loadStagingStageState(videoRoot, direction),
  });
  const currentHash = directionHash(direction);
  const acceptanceView = directionAcceptanceView(direction, manager.getDirectionAcceptance());
  const subjectHashes = directionPartHashes(direction);

  const partView = (address: string) => ({
    address,
    feedback: buildAddressFeedback(feedbackMgr, state, address, { subjectHashes }),
    handoffNote: handoffNoteForDirection(handoff, address),
  });
  // The shot's `role` never crosses the wire: `method` is a word the reviewer cannot argue with,
  // and naming it invites them to think they should. Its dramatic function does cross — as the
  // label ("rising", "payoff"), a claim about the piece they can dispute on instinct alone. That
  // function is read off the node's lens (a role the lens does not declare has none → null).
  const characterNameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
  );
  // The page shows names rather than ids. An id the character roster does not hold is a structural
  // error, so it prints as itself.
  const subjectNames = (ids: readonly string[] | undefined): string[] =>
    (ids ?? []).map((id) => characterNameById.get(id) ?? id);
  // The shot table's frame and space columns are read through the shot's setup — the reviewer reads
  // the size cadence down one and the space cadence down the other, and neither is declared per shot.
  const frameOf = shotFrameResolver(direction);
  const beatFunctionOf = (lensName: string, role: string): BeatFunction | null =>
    resolveLens(lensName, direction.lenses)?.beats.find((b) => b.role === role)?.fn ?? null;

  // `nodePath` is the field path of the node the shot sits in — a shot is reviewed where it is
  // declared, so its address hangs off its owner rather than off the root.
  const mapShot = (s: Shot, lensName: string, nodePath: readonly string[]) => {
    // An aside is no item of the arc, so every column the arc reads is null on it. What stays is what
    // a reviewer actually decides about one: that it is there, what it is, and how long it runs.
    if (isAsideShot(s)) {
      return {
        id: s.id,
        aside: true,
        graphic: false,
        beatFunction: null,
        beatFunctionLabel: null,
        action: s.label,
        setup: null,
        framing: null,
        location: null,
        script: [],
        lineup: [],
        lineupTo: [],
        join: null,
        cutin: null,
        telop: [...(s.telop ?? [])],
        duration: s.duration,
        ...partView(formatDirectionShotAddress(nodePath, s.id)),
      };
    }
    const fn = beatFunctionOf(lensName, s.role);
    const own = isGraphicShot(s) ? null : s;
    const cutin = s.cutin
      ? {
          setup: frameOf(s.cutin.setup).setupName,
          framing: frameOf(s.cutin.setup).framing,
          location: frameOf(s.cutin.setup).location,
          lineup: subjectNames(s.cutin.lineup),
          lineupTo: subjectNames(s.cutin.lineupTo),
          join: s.cutin.join ?? null,
        }
      : null;
    return {
      id: s.id,
      aside: false,
      graphic: own === null,
      // Drives the direction map's colors and the arc line's height.
      beatFunction: fn,
      beatFunctionLabel: fn ? BEAT_FUNCTION_LABEL[fn] : null,
      action: s.action,
      setup: own ? frameOf(own.setup).setupName : null,
      framing: own ? frameOf(own.setup).framing : null,
      location: own ? frameOf(own.setup).location : null,
      // The shot's spoken/narrated lines — reviewed with the action, character ids resolved to names.
      script: scriptLinesToView(s.script, characterNameById),
      // Who the frame holds, left to right, and the order the shot leaves behind. `join` is what the
      // boundary into this shot is, drawn between the rows rather than inside one.
      lineup: subjectNames(own?.lineup),
      lineupTo: subjectNames(own?.lineupTo),
      join: own?.join ?? null,
      cutin,
      // The shot's unspoken on-screen text. Bare strings — telop carries no speaker to resolve.
      telop: [...(s.telop ?? [])],
      duration: s.duration,
      ...partView(formatDirectionShotAddress(nodePath, s.id)),
    };
  };

  const pleasureView = (name: Pleasure) => ({ name, gloss: PLEASURE_GLOSS[name] });

  // A child node's view: its own beat function (read off its PARENT's lens, which orders it),
  // pleasure, and body — its shots (checked against this node's lens) or its child sequences
  // (recursively). Exactly one body is present, mirroring the DirectionNode it comes from.
  const mapChildNode = (
    node: DirectionNode,
    parentLens: string,
    parentPath: readonly string[],
  ): DirectionSequenceInfo => {
    const fn = node.role ? beatFunctionOf(parentLens, node.role) : null;
    const nodePath = directionChildNodePath(parentPath, node.id ?? "");
    return {
      id: node.id ?? "",
      beatFunction: fn,
      beatFunctionLabel: fn ? BEAT_FUNCTION_LABEL[fn] : null,
      synopsis: node.synopsis ?? "",
      pleasure: pleasureView(node.pleasure),
      ...partView(formatDirectionSequenceAddress(nodePath)),
      ...(Array.isArray(node.shots)
        ? { shots: node.shots.map((s) => mapShot(s, node.lens, nodePath)) }
        : {
            sequences: (node.sequences ?? []).map((c) => mapChildNode(c, node.lens, nodePath)),
          }),
    };
  };

  // Each brief field is its own feedback target, so a note argues with the tone (or the scope)
  // rather than with the concept wholesale. A prose field left unwritten is dropped, not rendered
  // empty; the two list fields are always rendered, empty included, so a reviewer can ask for an
  // entry the piece does not have yet.
  const briefFields = (brief: Partial<DirectionBrief>) =>
    DIRECTION_BRIEF_FIELDS.map((field) => {
      const view = partView(formatDirectionBriefAddress(field));
      if (isDirectionBriefListField(field)) {
        return { ...view, field, items: [...(brief[field] ?? [])] };
      }
      const text = brief[field];
      return text ? { ...view, field, text } : null;
    }).filter((f) => f !== null);

  // The always-declared policy fields, each its own feedback target below the brief. Structured
  // (not pre-formatted) so the UI owns the labels and glosses, as it does for the brief.
  const resolvedFormat = resolveDirectionFormat(direction);
  const policyFields: DirectionPolicyFieldInfo[] = [
    {
      field: "format",
      aspects: [ratioOf(resolvedFormat.size.delivery)],
      fps: resolvedFormat.fps,
      base: resolvedFormat.size.base,
      megapixels: resolvedFormat.size.megapixels,
      delivery: resolvedFormat.size.delivery,
      ...partView(formatDirectionPolicyAddress("format")),
    },
    {
      field: "lang",
      lang: direction.policy.lang,
      ...partView(formatDirectionPolicyAddress("lang")),
    },
    {
      field: "fonts",
      fonts: [...(direction.policy.fonts ?? [])],
      ...partView(formatDirectionPolicyAddress("fonts")),
    },
    {
      field: "speech",
      speech: direction.policy.speech,
      ...partView(formatDirectionPolicyAddress("speech")),
    },
  ];

  // Only waived findings reach the page. An unwaived finding — or a structure error — blocks
  // generation until the author clears it, so it never outlives their turn; putting it in front of
  // a reviewer would ask them to arbitrate a rule written for the checker, in a state that cannot
  // be accepted into anything anyway.
  //
  // A waiver is its own reviewable target: what was flagged, and the reason it was signed off.
  const waiverEntries = directionWaiverEntries(direction);
  const waivers = check.waived.map((f) => {
    const key = directionWaiverKey(f);
    const entry = waiverEntries.get(key);
    return {
      code: f.code,
      subject: f.subject ?? null,
      message: f.message,
      reason: entry?.reason ?? "",
      ...partView(formatDirectionWaiverAddress(entry?.nodePath ?? DIRECTION_ROOT_PATH, key)),
    };
  });

  const root = direction.sequence;

  const base = {
    mode: "direction-preview" as const,
    // The feeling the piece aims for — the one controlled term a reviewer can take a position on.
    // It is the root node's pleasure; the lens never crosses: choosing the shape is the agent's job,
    // and a reviewer says "this stretch drags", not "use kishotenketsu".
    pleasure: pleasureView(root.pleasure),
    directionHash: currentHash,
    // The verdict per box, which is the unit the page offers an Accept for. The header's own badge
    // is derived from these rather than sent beside them — two fields could disagree, and the one a
    // reviewer would believe is the one on the box they are reading.
    sections: Object.fromEntries(acceptanceView.sections) as Record<
      DirectionSection,
      DirectionSectionStatus
    >,
    gatingSections: directionGatingSections(manager.getDirectionAcceptance()),
    brief: briefFields(direction.brief ?? {}),
    policy: policyFields,
    sequence: partView(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH)),
    characters: Object.entries(direction.characters ?? {}).map(([id, c]) => ({
      id,
      name: c.name,
      description: c.description,
      ...(c.voice
        ? {
            voice: {
              description: c.voice.description,
              ...partView(formatDirectionCharacterVoiceAddress(id)),
            } satisfies DirectionVoiceInfo,
          }
        : {}),
      ...partView(formatDirectionCharacterAddress(id)),
    })),
    ...(direction.narrator
      ? {
          narrator: {
            description: direction.narrator.description,
            ...partView(DIRECTION_NARRATOR_ADDRESS),
          } satisfies DirectionVoiceInfo,
        }
      : {}),
    props: Object.entries(direction.props ?? {}).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
      ...partView(formatDirectionPropAddress(id)),
    })),
    locations: Object.entries(direction.locations ?? {}).map(([id, l]) => ({
      id,
      name: l.name,
      description: l.description,
      landmarks: Object.entries(l.landmarks ?? {}).map(([landmarkId, landmark]) => ({
        id: landmarkId,
        name: landmark.name,
        description: landmark.description,
      })),
      ...partView(formatDirectionLocationAddress(id)),
    })),
    // Grouped under their location on the page, so both are sent: the id it groups by, and the NAME
    // it reads against the space column rather than against the roster key. `holds` resolves the same
    // way, to its location's landmark names.
    setups: Object.entries(direction.setups ?? {}).map(([id, s]) => ({
      id,
      name: s.name,
      description: s.description,
      locationId: s.location,
      location: direction.locations?.[s.location]?.name ?? s.location,
      framing: s.framing,
      holds: (s.holds ?? []).map(
        (holdId) => direction.locations?.[s.location]?.landmarks?.[holdId]?.name ?? holdId,
      ),
      // The name, like `location` above. Sent only where the author declared one, so an undeclared
      // frame is not shown as a root while `within-undeclared` is asking it to choose.
      ...(s.within !== undefined
        ? { within: s.within ? (direction.setups?.[s.within]?.name ?? s.within) : null }
        : {}),
      ...partView(formatDirectionSetupAddress(id)),
    })),
    waivers,
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
  };

  // The root node drives the page's top level: a branch (sequences) → the sequenced view (each act
  // rendered recursively); a leaf (shots) → the flat view. Deeper nesting lives inside each act.
  if (Array.isArray(root.sequences)) {
    return jsonResponse({
      ...base,
      kind: "sequenced",
      sequences: root.sequences.map((child) => mapChildNode(child, root.lens, DIRECTION_ROOT_PATH)),
    });
  }
  return jsonResponse({
    ...base,
    kind: "flat",
    shots: (root.shots ?? []).map((s) => mapShot(s, root.lens, DIRECTION_ROOT_PATH)),
  });
}

// Direction review submit (`/api/direction/submit`). Two orthogonal outcomes: per-part feedback
// (routed to the `direction/static` stream) and a single direction Accept (stored in state, keyed
// to the live `directionHash`). The review record — saved only when there is feedback — nests
// under `review/direction/static/records/`; acceptance is durable in state regardless.

export async function handleDirectionSubmit(
  videoRoot: string,
  handoff: Handoff | null,
  direction: Direction,
  req: Request,
  reportOutcome?: ReportOutcome,
): Promise<Response> {
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations).
  const reviewedAt = new Date().toISOString();
  const body = await parseJsonBody<{
    addedFeedback: Array<{
      address: string;
      text: string;
      annotation: { kind: "pin"; x: number; y: number } | null;
      displayedVariants?: Record<string, string>;
    }>;
    feedbackPatches: Array<{ op: "edit" | "delete"; id: string; address: string; text?: string }>;
    // The staged verdicts, one per reviewed box: true signs off every part the section holds, false
    // revokes them (the spend gate re-blocks on that box). An absent section is untouched.
    sectionDecisions?: DirectionSectionDecisions;
    // The direction hash the reviewer actually looked at — the optimistic-concurrency token that
    // stops an Accept from signing off a version edited out from under the open review.
    reviewedHash?: string;
    overallComment?: string;
  }>(req);
  if (!body) {
    return errorResponse("Invalid request body", "INVALID_REQUEST", 400);
  }
  if (!isValidSubmitPayload("direction", body)) {
    return errorResponse("Invalid review payload", "INVALID_REQUEST", 400);
  }

  const currentHash = directionHash(direction);
  const sectionDecisions: DirectionSectionDecisions = body.sectionDecisions ?? {};
  const accepting = Object.values(sectionDecisions).some((v) => v === true);
  // An Accept signs off the box the reviewer saw; if direction.ts changed since the page loaded,
  // refuse rather than record a hash the human never reviewed. The guard is whole-direction even
  // though the verdict is per-section: the page is one read, and an edit anywhere can change what
  // the accepted box means (a shot moving into the act being signed off, say). The watcher's live
  // reload normally keeps the page current — this is the backstop for the edit-during-accept race.
  //
  // The token is mandatory to ACCEPT, not merely honoured when offered: a guard a caller opts into
  // is no guard, since the one caller it must stop is the one that does not know the page moved.
  // A revoke needs no token (it is safe against any version), and a feedback-only submit accepts
  // nothing, so neither has to prove what it read.
  if (accepting) {
    if (body.reviewedHash === undefined) {
      return errorResponse(
        "An accept must name the direction it reviewed (reviewedHash).",
        "INVALID_REQUEST",
        400,
      );
    }
    if (body.reviewedHash !== currentHash) {
      return errorResponse(
        "The direction changed since this review was opened — reload and re-review before accepting.",
        "DIRECTION_CHANGED",
        409,
      );
    }
  }

  // Every reviewable part of the current direction, keyed by its feedback address — both the guard
  // against a comment on a part that doesn't exist (a stale or forged address, which would land in
  // the stream as an un-renderable orphan) and the subject snapshot each new comment carries.
  const subjectHashes = directionPartHashes(direction);
  for (const fb of body.addedFeedback) {
    if (!subjectHashes.has(fb.address)) {
      return errorResponse(
        `Feedback address "${fb.address}" is not a part of the current direction`,
        "INVALID_ADDRESS",
        400,
      );
    }
  }

  const touchedAddresses = new Set<string>();
  for (const fb of body.addedFeedback) touchedAddresses.add(fb.address);
  for (const p of body.feedbackPatches) touchedAddresses.add(p.address);

  if (
    touchedAddresses.size === 0 &&
    Object.keys(sectionDecisions).length === 0 &&
    !body.overallComment
  ) {
    reportOutcome?.(emptyOutcome("direction"));
    return jsonResponse({ saved: false, filePath: null, accepted: false });
  }

  const addedFeedbackIds = new Set<string>();
  const editedFeedbackIds = new Set<string>(
    body.feedbackPatches.filter((p) => p.op === "edit").map((p) => p.id),
  );

  let reviewDecisions: ReviewDecisionEntry[] = [];
  // What this review left behind, read back under the same lock that wrote it: a concurrent
  // submit settling the other half of the page would otherwise decide whether the gate is open.
  let summary: DirectionAcceptanceSummary = {
    status: "unaccepted",
    blocking: 0,
    total: 0,
    gateBlocking: 0,
  };

  await StateManager.withLock(videoRoot, async (mgr) => {
    await FeedbackManager.withLock(videoRoot, "direction", async (fbMgr) => {
      // The subject snapshot is taken from the live direction, never from the client — a comment is
      // always anchored to the part as it reads right now.
      const added = body.addedFeedback.map((fb) => ({
        ...fb,
        subjectHash: subjectHashes.get(fb.address),
      }));
      for (const { id } of applyFeedbackMutations(fbMgr, added, body.feedbackPatches, reviewedAt)
        .added) {
        addedFeedbackIds.add(id);
      }
      // Before the section decisions below: an accept stamped over a comment ages it, and a record
      // computed after would hide the very comment its accept was made against.
      const staleBefore = staleFlagsBeforeDecisions(fbMgr, mgr.getState(), {
        cache: mgr.stalenessCache(),
        subjectHashes,
      });
      if (Object.keys(sectionDecisions).length > 0) {
        mgr.setDirectionAcceptance(
          applyDirectionSectionDecisions(direction, mgr.getDirectionAcceptance(), sectionDecisions),
        );
      }
      summary = summarizeDirectionAcceptance(direction, mgr.getDirectionAcceptance());
      reviewDecisions = [...touchedAddresses].map((address) => ({
        address,
        feedback: recordFeedbackFor(
          fbMgr,
          address,
          staleBefore,
          addedFeedbackIds,
          editedFeedbackIds,
        ),
      }));
    });
  });

  const record: ReviewRecord = {
    mode: "direction-preview",
    stage: "direction",
    createdAt: new Date().toISOString(),
    context: { shots: [], directionParts: Object.fromEntries(subjectHashes) },
    decisions: reviewDecisions,
    ...(Object.keys(sectionDecisions).length > 0
      ? {
          directionDecisions: Object.fromEntries(
            Object.entries(sectionDecisions).map(([section, accept]) => [
              section,
              accept ? ("accepted" as const) : ("none" as const),
            ]),
          ),
        }
      : {}),
    directionGate: {
      open: summary.gateBlocking === 0,
      blocking: summary.gateBlocking,
      total: summary.total,
    },
    ...(body.overallComment ? { overallComment: body.overallComment } : {}),
    ...handoffRecordFields(handoff),
  };
  const filePath = await saveReviewRecord(videoRoot, record);

  reportOutcome?.({ stage: "direction", filePath });

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    accepted: summary.status === "accepted",
  });
}
