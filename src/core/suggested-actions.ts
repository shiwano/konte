import {
  formatReferenceAddress,
  getStage,
  isMaterializedLeafAddress,
  isStageScope,
} from "./address.js";
import { type Finding, findingTraits, groupByFixIn } from "./finding.js";
import { isVariantStale, type StalenessCache } from "./staleness.js";
import { ERROR_GLIMPSE_WIDTH, truncateSingleLine } from "./truncate.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import type { ExportReadiness, LastExport } from "./status-sections.js";
import type { AssetState, KonteState, VariantState } from "./types/index.js";

// One step: a runnable command, or — when no command performs it — a `label` naming the edit it
// takes, parenthesized on the page so it never reads as something to run.
//
// `details` is what the step alone does not say, and it belongs to the step structurally rather than
// by sitting next to it: a detail written as its own entry would be re-attached by anything that
// reorders or drops a line (`dedupeCommands` does both). Most commands carry none — `konte reroll
// <address>` says what it does, and why it is offered is the state printed above it. A command that
// is offered for a reason the reader cannot see (a gate, a comment someone left) says it here.
export type SuggestedAction =
  | { command: string; details?: readonly string[] }
  | { command: null; label: string; details: readonly string[] };

// Suggested commands must be ready-to-run: generate/preview/export take a bare `<stage>` scope.
// Derive the exact stage scopes from the addresses in play — a set of assets can span both
// stages, so emit one per stage.
function stageScope(address: string): string | null {
  try {
    const stage = getStage(address);
    // A stage nobody can name in a command is not a scope to suggest — see isStageScope.
    return isStageScope(stage) ? stage : null;
  } catch {
    return null;
  }
}

// `clean` takes an ADDRESS-scope, not the stage-scope generate/preview take, and a bare `<stage>`
// is a valid one for every stage that owns addresses.
function cleanScope(address: string): string | null {
  try {
    return getStage(address);
  } catch {
    return null;
  }
}

function distinctScopes(addresses: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const addr of addresses) {
    const scope = stageScope(addr);
    if (scope) scopes.add(scope);
  }
  return [...scopes];
}

// Problem variants in the same stage can be cleaned in one shot via the stage-scoped
// `konte clean <stage>`, so group by scope and only fall back to a per-address clean when a
// scope has a single problem.
function suggestCleanForProblems(actions: SuggestedAction[], problemAddresses: string[]): void {
  const byScope = new Map<string, string[]>();
  for (const addr of problemAddresses) {
    const scope = cleanScope(addr);
    if (!scope) continue;
    const group = byScope.get(scope);
    if (group) group.push(addr);
    else byScope.set(scope, [addr]);
  }
  for (const [scope, addrs] of byScope) {
    if (addrs.length >= 2) {
      actions.push({ command: `konte clean ${scope}` });
    } else {
      actions.push({ command: `konte clean ${addrs[0]}` });
    }
  }
}

// Job-blind fallback used only when the caller can't supply the report's job-aware
// "Problems" set: a variant with no file and no error/cancel marker. It cannot tell a
// still-running variant apart from a dead one, so prefer the caller-supplied set.
function fallbackProblemAddresses(state: KonteState): string[] {
  return Object.entries(state.assets)
    .filter(([, a]) => {
      if (!a.variants) return false;
      return Object.values(a.variants).some(
        (v) => !v.file && !v.metadata?.error && !v.metadata?.cancelledAt,
      );
    })
    .map(([addr]) => addr);
}

// A failed generation job's error lives on its job record — and `konte clean`, the step below,
// deletes that record and its log along with the variant.
function suggestFailedJobDiagnosis(
  actions: SuggestedAction[],
  failedVariantIds: readonly string[],
): void {
  if (failedVariantIds.length === 0) return;
  const n = failedVariantIds.length;
  actions.push({
    command: null,
    label: "failed",
    details: [
      `${n} generation job${n === 1 ? "" : "s"} failed — \`konte job logs ${failedVariantIds[0]}\`` +
        " reads one; cleaning deletes the log with it",
    ],
  });
}

// A declared `file` asset whose media is not on disk. Nothing generates one and it has no variant
// for `clean` to take, so no other step reaches it. The cast's own missing files are named by the
// gate note above.
function suggestMissingFiles(actions: SuggestedAction[], paths: readonly string[]): void {
  if (paths.length === 0) return;
  actions.push({
    command: null,
    label: "add file",
    details: [`Provide the missing file(s): ${paths.join(", ")}`],
  });
}

// A job still in flight whose variant is gone from state. `konte prune` skips every active job, so
// it never clears one of these. Cancelling makes it terminal; `konte doctor` routes what it leaves
// behind to `prune`.
function suggestOrphanJobCancel(actions: SuggestedAction[], jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  actions.push({ command: `konte job cancel ${jobIds.join(" ")}` });
}

// A failed comfy provisioning job — a model download, a node install, a node activate. The retry
// needs no step of its own: the next `konte generate` resets a failed one to pending.
function suggestStandaloneFailureLogs(actions: SuggestedAction[], jobIds: readonly string[]): void {
  for (const jobId of jobIds) {
    actions.push({ command: `konte job logs ${jobId}` });
  }
}

// A patch script that would not load. It is keyed by its file path, never an address, so no
// command names it.
function suggestPatchScriptEdits(
  actions: SuggestedAction[],
  errors: readonly { filePath: string; message: string }[],
): void {
  for (const e of errors) {
    actions.push({
      command: null,
      label: `edit ${e.filePath}`,
      details: [truncateSingleLine(e.message, ERROR_GLIMPSE_WIDTH)],
    });
  }
}

function hasFreshPending(
  state: KonteState,
  address: string,
  a: AssetState,
  cache?: StalenessCache,
): boolean {
  if (!a.variants) return false;
  const variants = Object.values(a.variants);
  // An accepted asset is settled: its remaining unpicked variants are alternatives,
  // not pending review. Mirror the "Needs review" section (readyCount > 0 && !hasAccepted)
  // so Next steps never nags to re-review a fully-accepted stage.
  if (variants.some((v: VariantState) => v.status === "accepted")) return false;
  return variants.some(
    (v: VariantState) =>
      v.status === "none" &&
      v.file !== null &&
      !isVariantStale(state, address, v, null, undefined, cache),
  );
}

// The step a standing comment asks for is to READ it: konte knows a comment stands, not what it
// says, and which fix it needs is a routing decision whose outcomes are mostly edits no command can
// name. Never gated — reading spends nothing, so a comment on a stage whose spend would abort is
// surfaced like any other.
function suggestFeedbackRead(actions: SuggestedAction[], addresses: readonly string[]): void {
  if (addresses.length === 0) return;
  actions.push({
    command: "konte review feedback list",
    details: [
      addresses.length === 1
        ? "1 address carries a comment"
        : `${addresses.length} addresses carry comments`,
    ],
  });
}

// A stale (accepted) composition cannot be rerolled — it is the assembled shotFn output,
// auto-re-materialized by the pipeline from the changed upstreams. Its baseline is refreshed
// by re-reviewing the shot and accepting the fresh variant. Re-review is per stage, so dedupe
// stale compositions to one preview per scope.
function suggestCompositionReReview(
  actions: SuggestedAction[],
  compositionAddresses: string[],
): void {
  for (const scope of distinctScopes(compositionAddresses)) {
    actions.push({ command: `konte preview ${scope}` });
  }
}

// The findings, one step per file they are fixed in — the edit, which no command performs. A take
// found wrong is cleared by hearing it instead: the probe that shows its line beside what was heard.
function prependFindings(actions: SuggestedAction[], findings: readonly Finding[]): void {
  const vouchable = findings.filter((f) => findingTraits(f.code).clears === "vouch");
  const steps: SuggestedAction[] = groupByFixIn(
    findings.filter((f) => findingTraits(f.code).clears !== "vouch"),
  ).map(({ file, findings: group }) => ({
    command: null,
    label: `edit ${file}`,
    details: [
      `Fix the ${group.length} finding(s) listed under it below` +
        (group.some((f) => findingTraits(f.code).clears === "waive")
          ? `, or waive a waivable one by its key in ${STAGE_ENTRY_FILE.direction}`
          : ""),
    ],
  }));
  if (vouchable.length > 0) {
    steps.push({
      command: `konte probe audio ${[...new Set(vouchable.map((f) => f.subject))].join(" ")}`,
      details: [
        "Dismiss a broken take (reroll for another beside it); `konte vouch <variantId>` one that is fine",
      ],
    });
  }
  actions.unshift(...steps);
}

// A human accept whose own definition moved. The take is the human's pick, so the step is the
// agent's own: writing the definition back to what made it — free, and the accept stands; `reroll`
// draws a rival only on their request.
function suggestDefinitionRestores(
  actions: SuggestedAction[],
  restores: readonly DefinitionRestore[],
): void {
  for (const { address, variantId, fields } of restores) {
    const what = fields.length > 0 ? fields.join(", ") : "its definition";
    const file = STAGE_ENTRY_FILE[getStage(address)];
    actions.push({
      command: `konte inspect ${variantId}`,
      details: [
        `${address}: accepted against a changed definition — the human's accept stands; restore ${what}` +
          ` in ${file} to what made it yourself, without raising it with the human` +
          ` (\`konte reroll ${address}\` only when they ask for the change)`,
      ],
    });
  }
}

// Stale compositions route to a per-scope re-review; the rest to whichever command actually
// replaces the take. `reroll`/`generate` are gated by the spend gates, a re-review only by a class
// its compositions carry — a blocked stage drops what would abort.
//
// Every address here carries an ACCEPTED stale variant (collectStaleVariants returns no other), and
// `generate` skips an accepted asset even when stale (`assetSkipReason`'s "accepted-stale"), so
// grouping them into one `konte generate <stage>` would name a command that does nothing. A
// deterministic take is the exception — its accept was konte's own, and `generate` re-bakes it.
function suggestStaleRefresh(
  actions: SuggestedAction[],
  staleAddresses: string[],
  deterministicStaleAddresses: string[],
  spendBlocked: (address: string) => boolean,
  reviewBlocked: (address: string) => boolean,
  isLeaf: (address: string) => boolean,
): void {
  // Only an address a command can name. Every real stage is, so this catches nothing but an
  // address that will not parse.
  const refreshable = staleAddresses.filter((addr) => stageScope(addr) !== null);
  const compositions = refreshable.filter(isLeaf).filter((addr) => !reviewBlocked(addr));
  const assets = refreshable.filter((addr) => !isLeaf(addr)).filter((addr) => !spendBlocked(addr));

  suggestCompositionReReview(actions, compositions);

  for (const addr of assets) {
    actions.push({ command: `konte reroll ${addr}` });
  }
  for (const scope of distinctScopes(
    deterministicStaleAddresses.filter((addr) => !spendBlocked(addr)),
  )) {
    actions.push({ command: `konte generate ${scope}` });
  }
}

// While the direction holds an animatic/video spend, reviewing it is the single highest-priority
// next step — it goes at the very top, ahead of any per-asset review or generate.
// `directionReviewNeeded` is the caller's (status) `gateSatisfied`, not `complete`: a part that
// changed after the piece was accepted whole is shown on the review page but is not a step, and
// offering one would send the reviewer to re-read what the stage reel already showed them.
//
// A piece cut to a song is written after it: while the song has no accepted take, an empty direction
// is not the next thing to write — the song is the next thing to make and hear, once the brief,
// policy and lyrics it is made from are accepted.
function prependDirectionReview(
  actions: SuggestedAction[],
  needed: boolean | undefined,
  empty: boolean | undefined,
  song: SongPending | undefined,
): void {
  if (!needed) return;
  if (empty) {
    actions.unshift({
      command: null,
      label: "edit",
      details: [
        song
          ? `Write the shots in direction.ts, each counted in beats, once ${song.address} is accepted`
          : "Write your direction in direction.ts",
      ],
    });
    if (song) {
      actions.unshift({
        command: song.hasTake
          ? "konte preview reference"
          : song.directionReviewNeeded
            ? "konte preview direction"
            : "konte generate reference",
      });
    }
    return;
  }
  actions.unshift({ command: "konte preview direction" });
}

// A cast reference — a character's look or a cast voice's sample — whose `reference:<id>` asset is
// not yet accepted. `missingFile` carries the declared path of a `file` asset, which is satisfied by
// putting media there — never generated. `declared` is whether reference.tsx exposes the asset; one
// it does not has no step here, since no command makes it. `blocks` is "all" for a look, which every
// shot is drawn from: developing more shots waits on it, never on a voice.
type UnacceptedCastRef = {
  id: string;
  declared: boolean;
  missingFile: string | null;
  blocks: "all" | "video";
};

// The cast holds animatic/video spend exactly as the direction does (the spend gate's cast), so it
// sits directly under the direction review and above any per-asset step.
// Which step it is depends on where the reference stalled: a `file` one is waiting on its media, a
// generated one on its first `generate`, and one that already has an output only on its accept.
function prependCastGate(
  actions: SuggestedAction[],
  state: KonteState,
  unacceptedCast: readonly UnacceptedCastRef[] | undefined,
): void {
  const cast = (unacceptedCast ?? []).filter((c) => c.declared);
  if (cast.length === 0) return;
  const steps: SuggestedAction[] = [];

  const generated = cast.filter((c) => c.missingFile === null);
  if (generated.length > 0) {
    const scope = "reference";
    const anyOutput = generated.some((c) =>
      Object.values(state.assets[formatReferenceAddress(c.id)]?.variants ?? {}).some(
        // A dismissed take is not output to go and review — that sheet is work for `generate`.
        (v) => v.file !== null && v.status !== "dismissed",
      ),
    );
    steps.push({ command: anyOutput ? `konte preview ${scope}` : `konte generate ${scope}` });
  }

  const files = cast.filter((c) => c.missingFile !== null);
  if (files.length > 0) {
    steps.push({
      command: null,
      label: "add file",
      details: [`Provide the missing cast file(s): ${files.map((c) => c.missingFile).join(", ")}`],
    });
  }

  // A plain `konte generate reference` may already be in the body; unshifting here puts the gate's
  // copy first and `dedupeCommands` drops the later twin, so the gate keeps its priority.
  actions.unshift(...steps);
}

// `generate` is stage-scoped and skips whatever is accepted, ready, or already in flight, so one
// command per stage that still has something to make is the whole step. Driven by the report's
// definition-derived `notGenerated`: `state` alone cannot see a never-generated asset, which has no
// state entry at all. `needsRegenerate` carries the other half — an asset whose only takes have
// gone stale, which `generate` replaces just the same.
function suggestGenerate(
  actions: SuggestedAction[],
  readiness: readonly ExportReadiness[],
  stageBlocked: (stage: string) => boolean,
): void {
  for (const r of readiness) {
    // Minus what the animatic gate holds: `generate` skips those, so a stage whose whole work list
    // is held would return having spent nothing — the misread this block exists to prevent, and the
    // one `konte preview video` above it is the actual step for.
    const work = r.notGenerated.length + r.needsRegenerate.length;
    if (work <= 0 || stageBlocked(r.label)) continue;
    // Same rule as everywhere else: only a stage a command can name. An unbaked depth map is
    // produced by the run of whichever stage consumes it, which this loop suggests on its own.
    if (!isStageScope(r.label)) continue;
    actions.push({ command: `konte generate ${r.label}` });
  }
}

// The deliverable is the point of the tool, so the moment the video stage can produce one is the
// moment to say so. Only `video`: an animatic contact sheet is a side artifact nobody is working
// toward, and suggesting it whenever the animatic completes would nag. Silent once a current
// export already exists — there is nothing to do then.
function suggestExport(
  actions: SuggestedAction[],
  readiness: readonly ExportReadiness[],
  lastExports: readonly LastExport[] | undefined,
  stageBlocked: (stage: string) => boolean,
): void {
  const current = lastExports?.find((e) => e.label === "video");
  if (current?.noDelivery) {
    actions.push({ command: "konte probe export" });
    return;
  }
  const video = readiness.find((r) => r.label === "video");
  if (!video || video.total === 0 || stageBlocked("video")) return;
  // An undeveloped shot carries no address, so it never shows in the ratio — but export refuses
  // while one remains.
  if (video.pendingShots > 0) return;
  if (video.accepted !== video.total || video.leavesUnsigned || video.refsUnaccepted > 0) return;
  const reel = video.reel;
  if (
    reel &&
    (reel.acceptedShots !== reel.shots || reel.soundtrackUnsigned || reel.overlayUnsigned)
  ) {
    return;
  }
  if (current && !current.outOfDate) return;
  if (video.deliveryUpscalerMissing) {
    actions.push({
      command: null,
      label: "edit",
      details: [
        `Wire export.delivery.upscale.video or .frame in ${STAGE_ENTRY_FILE.video}, or raise policy.format.size.megapixels in ${STAGE_ENTRY_FILE.direction} so the canvas meets the delivery`,
      ],
    });
    return;
  }
  actions.push({ command: "konte export video" });
}

// Keeps the first occurrence of each command, so a prepended gate step outranks the plain twin the
// body emitted — and folds the twin's details into it, since the reason the later copy was offered
// holds for the one that survives. Label steps are kept as written: each says something only it says.
export function dedupeCommands(actions: SuggestedAction[]): SuggestedAction[] {
  const kept = new Map<string, { command: string; details?: string[] }>();
  const out: SuggestedAction[] = [];
  for (const action of actions) {
    if (action.command === null) {
      out.push(action);
      continue;
    }
    const first = kept.get(action.command);
    if (first) {
      if (action.details?.length) {
        first.details = [...new Set([...(first.details ?? []), ...action.details])];
      }
      continue;
    }
    const entry = {
      command: action.command,
      ...(action.details?.length ? { details: [...action.details] } : {}),
    };
    kept.set(action.command, entry);
    out.push(entry);
  }
  return out;
}

export function formatSuggestedActions(actions: SuggestedAction[]): string {
  if (actions.length === 0) return "";

  // A step per line, its details indented under it — the nesting is what says which step they are
  // about, so no detail can be read against the line above or below it.
  const lines = ["Next steps:"];
  for (const action of actions) {
    lines.push(action.command === null ? `  (${action.label})` : `  ${action.command}`);
    for (const detail of action.details ?? []) lines.push(`    ${detail}`);
  }

  return lines.join("\n");
}

interface SuggestStatusInput {
  state: KonteState;
  /**
   * The caller's resolution memo. Without it the state-only fallbacks below read the input axis
   * alone, and a "needs review" nudge can name a take the review page no longer shows.
   */
  stalenessCache?: StalenessCache;
  /**
   * The report's "Needs review" addresses, computed by the caller that has the live definitions (so
   * a composition's definition-staleness is accounted for). Falls back to the state-only
   * `hasFreshPending` heuristic, which cannot see it.
   */
  pendingReviewAddresses?: readonly string[];
  /** Every finding standing (see `collectFindings`). */
  findings?: readonly Finding[];
  /** Stages whose `generate` the spend gate would refuse right now. */
  spendHeldStages?: readonly string[];
  /** Stages whose `konte preview` the review gate would refuse right now. */
  previewHeldStages?: readonly string[];
  /**
   * The report's job-aware "Problems" addresses. The state-only fallback cannot see job state, so it
   * wrongly flags a still-running variant (no file yet, no error) as a problem.
   */
  problemAddresses?: readonly string[];
  /** The report's per-stage readiness — what is left to generate, and whether video can export. */
  readiness?: readonly ExportReadiness[];
  /** The report's last export, so a current deliverable isn't re-suggested. */
  lastExports?: readonly LastExport[];
  /**
   * Pending patches this function cannot judge on its own — a patch whose own findings hold it. Its
   * caller has the patch catalog; this one has only stages and addresses.
   */
  blockedPatchAddresses?: readonly string[];
  /** Addresses with a declared-but-unrealized patch, from the report's "Pending patches". */
  pendingPatchAddresses?: readonly string[];
  /** Board stems a video spend re-mixes first, from the report's "Board stems to re-mix". */
  boardRemixAddresses?: readonly string[];
  /**
   * The report's accepted-and-stale addresses, minus the ones another step already owns (a fresh
   * take awaiting accept, a patch to re-apply, a `#delivery` only `export` can rebuild).
   */
  staleAddresses?: readonly string[];
  /** Of those, the deterministic ones — the only stale accepts `generate` will re-bake. */
  deterministicStaleAddresses?: readonly string[];
  /** Human accepts whose own definition moved, apart from `staleAddresses`. */
  definitionRestores?: readonly DefinitionRestore[];
  /** Variant ids of the failed generation jobs behind `problemAddresses`. */
  failedJobVariantIds?: readonly string[];
  /** Declared paths of `file` assets whose media is absent, minus the cast's (the gate names those). */
  missingFilePaths?: readonly string[];
  /** Job ids from the report's orphan jobs — in flight, with no variant left in state. */
  orphanJobIds?: readonly string[];
  /** Job ids of the report's failed provisioning jobs and failed latest export. */
  standaloneFailureJobIds?: readonly string[];
  /** Patch scripts the report could not load, each with its error. */
  patchErrors?: readonly { filePath: string; message: string }[];
  /** True when the direction is unaccepted or changed since acceptance. Surfaced first. */
  directionReviewNeeded?: boolean;
  /** The direction's cast — character looks and voice samples — whose reference asset is not yet accepted. */
  unacceptedCast?: readonly UnacceptedCastRef[];
  /** True when the direction declares no shots yet — the step points at authoring, not reviewing. */
  directionEmpty?: boolean;
  /** The song `policy.song` names, while no take of it is accepted. */
  songPending?: SongPending;
  /** Takes of the song waiting to be read — their analysis jobs run under `konte job wait`. */
  songReadingsPending?: boolean;
  /** A job is still running or queued — `konte job wait`. */
  jobsInFlight?: boolean;
  /** Active jobs that are not progressing (`jobStatusFlags`) — `konte job show` diagnoses each. */
  stuckJobIds?: readonly string[];
  /** Takes of the song no job is reading — `konte song analyze` reads them. */
  songUnread?: boolean;
  /**
   * Addresses whose comments still stand — a stale one has already been answered by whatever aged
   * it (the take moved under it, or an accept was stamped over it), so it asks for nothing.
   */
  feedbackAddresses?: readonly string[];
  /** Undeveloped video shots whose animatic shot is developed with every asset accepted. */
  boardedPendingVideoShots?: readonly string[];
  /** The undeveloped shots of the first leaf sequence still holding an undeveloped video shot. */
  nextSequencePendingShots?: { animatic: readonly string[]; video: readonly string[] };
}

export type DefinitionRestore = {
  address: string;
  variantId: string;
  // The definition fields moved since the take was made; empty when the diff cannot be read.
  fields: readonly string[];
};

export type SongPending = {
  address: string;
  // Whether a take exists to hear — otherwise the song is still to be generated.
  hasTake: boolean;
  // Whether `generate reference` refuses the song until the brief, policy and lyrics are accepted.
  directionReviewNeeded: boolean;
};

export function suggestForStatus(input: SuggestStatusInput): SuggestedAction[] {
  const { state } = input;
  const actions: SuggestedAction[] = [];

  // The spend gate and the review gate decide what is offered.
  const cast = input.unacceptedCast ?? [];
  // Developing more shots waits on the direction and the cast every shot is built from.
  const gated = input.directionReviewNeeded === true || cast.some((c) => c.blocks === "all");
  const spendHeld = new Set(input.spendHeldStages ?? []);
  const previewHeld = new Set(input.previewHeldStages ?? []);
  const stageBlocked = (s: string) => spendHeld.has(s);
  const addressBlocked = (addr: string) => stageBlocked(getStage(addr));

  // Ahead of the review suggestions: what the human already asked for outranks showing them more.
  suggestFeedbackRead(actions, input.feedbackAddresses ?? []);

  const pendingAddresses =
    input.pendingReviewAddresses ??
    Object.entries(state.assets)
      .filter(([addr, a]) => hasFreshPending(state, addr, a, input.stalenessCache))
      .map(([addr]) => addr);
  for (const scope of distinctScopes(pendingAddresses)) {
    // The edit step for what holds it stands in for a refused review.
    if (previewHeld.has(scope)) continue;
    actions.push({ command: `konte preview ${scope}` });
  }

  suggestFailedJobDiagnosis(actions, input.failedJobVariantIds ?? []);
  suggestCleanForProblems(actions, [
    ...(input.problemAddresses ?? fallbackProblemAddresses(state)),
  ]);
  // The rest of "Problems": none of these has a variant for `clean` to act on.
  suggestMissingFiles(actions, input.missingFilePaths ?? []);
  suggestOrphanJobCancel(actions, input.orphanJobIds ?? []);
  suggestStandaloneFailureLogs(actions, input.standaloneFailureJobIds ?? []);

  suggestDefinitionRestores(actions, input.definitionRestores ?? []);
  suggestStaleRefresh(
    actions,
    [...(input.staleAddresses ?? [])],
    [...(input.deterministicStaleAddresses ?? [])],
    addressBlocked,
    (addr) => previewHeld.has(getStage(addr)),
    isMaterializedLeafAddress,
  );

  // A pending patch is unrealized declared work, so it is offered like a generate — and gated the
  // same way, since applying one spends. The bare `konte patch apply` takes EVERY pending patch and
  // runs its gates over the whole set before applying any, so one blocked patch aborts the run: the
  // step is offered only when none is blocked. `blockedPatchAddresses` carries
  // the ones this function cannot judge for itself — a patch's own prompt findings are per file, not
  // per stage.
  const pendingPatches = input.pendingPatchAddresses ?? [];
  const blockedPatches = new Set(input.blockedPatchAddresses ?? []);
  const patchBlocked = (addr: string) => addressBlocked(addr) || blockedPatches.has(addr);
  if (pendingPatches.length > 0 && !pendingPatches.some(patchBlocked)) {
    if (distinctScopes(pendingPatches).length > 0) actions.push({ command: "konte patch apply" });
  }
  suggestPatchScriptEdits(actions, input.patchErrors ?? []);
  if ((input.boardRemixAddresses ?? []).length > 0 && !stageBlocked("video")) {
    actions.push({ command: "konte generate video" });
  }

  const readiness = input.readiness ?? [];
  suggestGenerate(actions, readiness, stageBlocked);
  suggestExport(actions, readiness, input.lastExports, stageBlocked);

  prependCastGate(actions, state, input.unacceptedCast);
  prependDirectionReview(
    actions,
    input.directionReviewNeeded,
    input.directionEmpty,
    input.songPending,
  );
  // Ahead of the reviews: the song's page lays a take's beats and lines over it, which a take not
  // read yet has neither.
  if (input.songReadingsPending || input.jobsInFlight) {
    actions.unshift({ command: "konte job wait" });
  }
  // Ahead of the wait, which would block on a job that is not progressing.
  for (const id of [...(input.stuckJobIds ?? [])].reverse()) {
    actions.unshift({ command: `konte job show ${id}` });
  }
  if (input.songUnread) actions.unshift({ command: "konte song analyze" });
  // A shotless direction's one finding is that it has no shots, which the "write your direction"
  // step already says.
  if (!input.directionEmpty) prependFindings(actions, input.findings ?? []);
  if (!gated) {
    suggestDevelopment(
      actions,
      input.boardedPendingVideoShots ?? [],
      input.nextSequencePendingShots,
    );
  }
  return dedupeCommands(actions);
}

function shotList(ids: readonly string[]): string {
  return `shot${ids.length === 1 ? "" : "s"} ${ids.join(", ")}`;
}

function suggestDevelopment(
  actions: SuggestedAction[],
  boarded: readonly string[],
  next: SuggestStatusInput["nextSequencePendingShots"],
): void {
  if (boarded.length > 0) {
    actions.push({
      command: null,
      label: "edit",
      details: [
        `Develop video ${shotList(boarded)} in ${STAGE_ENTRY_FILE.video} from the accepted animatic`,
      ],
    });
    return;
  }
  if (!next || next.video.length === 0 || actions.length > 0) return;
  const parts = [
    ...(next.animatic.length > 0
      ? [`animatic ${shotList(next.animatic)} in ${STAGE_ENTRY_FILE.animatic}`]
      : []),
    `video ${shotList(next.video)} in ${STAGE_ENTRY_FILE.video}`,
  ];
  actions.push({
    command: null,
    label: "edit",
    details: [`Develop the next sequence: ${parts.join(", ")}`],
  });
}
