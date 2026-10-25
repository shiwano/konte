import { format } from "oxfmt";
import type { Stage } from "./address.js";
import type { DirectionFindingCode } from "./direction-check.js";
import { type DirectionErrorCode, findingFixStage } from "./direction.js";
import {
  DIRECTION_FINDING_CODES,
  type FindingCode,
  type FindingTraits,
  findingTraits,
  spendStages,
} from "./finding.js";
import { STAGE_ENTRY_FILE } from "./roots.js";

// The source of `docs/FINDINGS.md`. Each record is keyed by the finding code set, so a new code with
// no entry here is a compile error, and `findings-doc.test.ts` fails until the document is
// regenerated (`bun run build:generate-findings-doc`). Only what the code cannot say is written by
// hand; what a finding reads, clears by, holds and sets in with are read off the registry.

type DirectionFindingDoc = {
  flags: string;
  // What the `_<subject>` half of the waiver key names; `null` where the key is the code alone.
  subject: string | null;
  // A literal value is also refused by the type layer (`ConstrainIds`, `StageChain`).
  typeLevel?: true;
};

export const DIRECTION_FINDING_DOCS: Record<DirectionFindingCode, DirectionFindingDoc> = {
  "missing-role": { flags: "A role its lens requires has no item.", subject: "role" },
  "no-payoff": { flags: "No item takes the lens's payoff role.", subject: null },
  "role-out-of-order": {
    flags: "A role appears before one its lens places earlier.",
    subject: "role that arrived early",
  },
  "lens-role-mismatch": {
    flags: "An item's role is not one its node's lens declares.",
    subject: "item id",
    typeLevel: true,
  },
  "too-few-consecutive": {
    flags: "A role's longest run is shorter than its `minConsecutive`.",
    subject: "role",
  },
  "empty-synopsis": {
    flags: "A shot's `action` or a child node's `synopsis` is empty.",
    subject: "item id",
    typeLevel: true,
  },
  "unearned-payoff": {
    flags: "The payoff lands before any item grounds, turns or builds toward it.",
    subject: "payoff role",
  },
  "role-overweight": {
    flags: "A role holds more of the runtime than its `maxShare`.",
    subject: "role",
  },
  "role-underweight": {
    flags: "A role holds less of the runtime than its `minShare`.",
    subject: "role",
  },
  "song-unreferenced": {
    flags: "`policy.song` names no `reference:<id>` asset.",
    subject: null,
  },
  "song-overrun": {
    flags: "The timeline runs on past the end of the take of the song.",
    subject: null,
  },
  "lyric-unplaced": {
    flags: "A lyric line nobody placed on the take of the song is not clearly sung anywhere in it.",
    subject: "line (`<section>.<line>`, from 1)",
  },
  "character-unreferenced": {
    flags: "A character a frame's lineup holds has no `reference:<id>` asset.",
    subject: "character id",
  },
  "unused-character": {
    flags: "A character is named in no shot action and speaks no line.",
    subject: "character id",
  },
  "character-voice-missing": {
    flags: "A character speaks but casts no `voice`.",
    subject: "character id",
  },
  "character-voice-unreferenced": {
    flags: "A character's voice has no `reference:<id>` sample.",
    subject: "character id",
  },
  "unused-character-voice": {
    flags: "A character has a voice but no script line.",
    subject: "character id",
  },
  "narrator-missing": {
    flags: "The direction has narration lines but casts no `narrator`.",
    subject: null,
  },
  "narrator-unreferenced": {
    flags: "The narrator's voice has no `reference:<id>` sample.",
    subject: null,
  },
  "unused-narrator": {
    flags: "A narrator is cast but no shot declares a narration line.",
    subject: null,
  },
  "prop-unreferenced": { flags: "A prop has no `reference:<id>` asset.", subject: "prop id" },
  "unused-prop": { flags: "A prop is named in no shot action.", subject: "prop id" },
  "location-unreferenced": {
    flags: "A location has no `reference:<id>` asset.",
    subject: "location id",
  },
  "unused-location": {
    flags: "No setup a shot points at is set in a location.",
    subject: "location id",
  },
  "setup-unrealized": {
    flags: "A setup two or more generated shots share has no plate.",
    subject: "setup id",
  },
  "plate-unanchored": {
    flags: "A plate is built from no location reference.",
    subject: "setup id",
  },
  "plate-unnested": {
    flags:
      "A plate is neither a cut from, nor a window inside, the plate of the setup it is `within`.",
    subject: "setup id",
  },
  "axis-unrealized": {
    flags: "Two sizes cut along one `within` axis lack the plates that nest them.",
    subject: "setup pair (`<a>.<b>`)",
  },
  "setup-unconsumed": {
    flags:
      "A developed shot builds no keyframe from its setup's plate, or from the location reference where there is no plate.",
    subject: "setup id",
  },
  "unused-setup": { flags: "No shot points at a setup.", subject: "setup id" },
  "setup-atomized": {
    flags: "A location holds many shots but almost none share a frame.",
    subject: "location id",
  },
  "view-unrealized": {
    flags: "A used setup faces a view of its location that has no view image.",
    subject: "`<locationId>.<view>`",
  },
  "plate-unviewed": {
    flags:
      "A plate, or a keyframe on a setup with no plate, reaches its location through another view's image, not its own view's.",
    subject: "setup id",
  },
  "view-unanchored": {
    flags: "A view image is built from no location master.",
    subject: "`<locationId>.<view>`",
  },
  "unexpected-script": {
    flags:
      "A shot's `script` contradicts `policy.speech`: any line under `none`, a spoken line under `no-dialogue`.",
    subject: "shot id",
    typeLevel: true,
  },
  "multi-sentence-action": {
    flags: "A shot's `action` reads as two or more sentences.",
    subject: "shot id",
  },
  "off-grid-duration": {
    flags:
      "A shot's `duration` is not a positive multiple of 0.5s, or on `policy.song` its `beats` is not positive.",
    subject: "shot id",
    typeLevel: true,
  },
  "off-beat-cut": {
    flags:
      "On `policy.song`, a shot's `beats` is not a whole number, so the cut after it lands off the beat.",
    subject: "shot id",
  },
  "fonts-undeclared": {
    flags: "`policy.lang` is in a script no default face covers, and `policy.fonts` is empty.",
    subject: null,
  },
  "lineup-flipped": {
    flags:
      "A `lineup` reverses a left-to-right order an earlier shot set in that location, and no shot between them declares the move.",
    subject: "frame (`<shotId>` or `<shotId>.cutin`)",
  },
  "lineup-gap": {
    flags: "A frame's two ends skip someone the location places between them.",
    subject: "frame",
  },
  "lineup-vacuous": {
    flags: "A `lineupTo` repeats its `lineup`.",
    subject: "frame",
    typeLevel: true,
  },
  "lineup-inconsistent": {
    flags: "The order accumulated in a location forms a cycle.",
    subject: "frame",
  },
  "location-backtrack": {
    flags:
      "A frame puts a character back in a location they left, and no `jump-back` / `jump-forward` join since moves story time.",
    subject: "`<frame>.<characterId>`",
  },
  "character-unconsumed": {
    flags: "A keyframe framing a character is built from no reference to them.",
    subject: "`<frame>.<characterId>`",
  },
  "slot-order-mismatch": {
    flags: "A keyframe passes its reference images in an order its `lineup` does not declare.",
    subject: "frame",
  },
  "plate-recropped": {
    flags: "A keyframe on a plated setup crops the plate, a frame its setup does not declare.",
    subject: "frame",
  },
  "landmark-flipped": {
    flags: "Two setups of one location disagree on the left-to-right order of its landmarks.",
    subject: "setup id",
  },
  "passer-unconsumed": {
    flags: "A video take's input chain does not reach a passing character's reference.",
    subject: "`<frame>.<characterId>`",
  },
  "passer-unnamed": {
    flags:
      "A video take's positive prompts omit a passing character's promptDepiction (case-insensitive).",
    subject: "`<frame>.<characterId>`",
  },
  "subject-unnamed": {
    flags:
      "No prompt behind a keyframe contains the `promptDepiction` of a subject it frames, verbatim (case-insensitive).",
    subject: "`<frame>.<characterId>`",
  },
  "prop-unnamed": {
    flags:
      "A shot's `action` names a prop, but no prompt behind its keyframes contains the prop's `promptDepiction`, verbatim (case-insensitive), and the shot does not put the prop's reference on screen through no generative step.",
    subject: "`<shotId>.<propId>`",
  },
  "plate-unnamed": {
    flags:
      "No prompt a plate is generated with contains the `promptDepiction` of a landmark its setup's `holds` declares, verbatim (case-insensitive).",
    subject: "`<setupId>.<landmarkId>`",
  },
  "landmark-unnamed": {
    flags:
      "On a setup with no plate, a keyframe's prompts omit the `promptDepiction` of a landmark the frame holds, verbatim (case-insensitive).",
    subject: "`<frame>.<landmarkId>`",
  },
  "join-lineup-mismatch": {
    flags: "A `continuous` shot opens on a different order than the shot before it leaves.",
    subject: "frame",
  },
  "join-unpinned": {
    flags:
      "The video take before a `continuous` seam does not pin its end to the opening keyframe of the shot after it, where its model has an end slot.",
    subject: "frame",
  },
  "join-unshown": {
    flags:
      "A take pinned to a `continuous` seam is played off that frame: the take before does not cut on the frame its end image lands on, or the take after does not open its shot on its first (`mediaStart`, `duration`).",
    subject: "frame",
  },
  "opening-key": {
    flags:
      "A frame boarded on one keyframe, not running on from the frame before, has that key pinned as the first frame of a video take whose model also takes an unpinned image, unless that take is accepted against its current definition.",
    subject: "frame",
  },
  "panel-unlinked": {
    flags:
      "A keyframe opening a cut along one `within` axis, on a model that reads a previous panel (`readsPrevPanel`), takes no previous panel, or another frame, among its image inputs. A cut between two frames whose lineups hold subjects but none in common is exempt.",
    subject: "seam (`<from>-<id>`, `.cutin` for a cutin)",
  },
};

export const DIRECTION_ERROR_DOCS: Record<DirectionErrorCode, string> = {
  "direction-missing": "The video has no `direction.ts`.",
  "empty-direction": "The direction declares no shot.",
  "duplicate-id": "An id is declared more than once.",
  "unknown-lens": "A node names a lens that is neither built in nor declared.",
  "payoff-not-in-roles": "A lens's payoff is not one of its roles.",
  "payoff-function-mismatch": "A lens's payoff role is not a payoff-function role.",
  "empty-roles": "A lens declares no roles.",
  "invalid-share": "A role's `minShare` / `maxShare` is not a fraction in [0, 1].",
  "character-invalid-id": "A character id is not a valid asset name.",
  "character-empty-name": "A character has an empty `name`.",
  "character-empty-description": "A character has an empty `description`.",
  "character-empty-prompt-depiction": "A character has an empty `promptDepiction`.",
  "character-voice-invalid-id": "A character's voice id is not a valid asset name.",
  "character-voice-empty-description": "A character's voice has an empty `description`.",
  "narrator-invalid-id": "The narrator's voice id is not a valid asset name.",
  "narrator-empty-description": "The narrator's voice has an empty `description`.",
  "prop-invalid-id": "A prop id is not a valid asset name.",
  "prop-empty-name": "A prop has an empty `name`.",
  "prop-empty-description": "A prop has an empty `description`.",
  "prop-empty-prompt-depiction": "A prop has an empty `promptDepiction`.",
  "location-invalid-id": "A location id is not a valid asset name.",
  "location-empty-name": "A location has an empty `name`.",
  "location-empty-description": "A location has an empty `description`.",
  "location-empty": "The direction declares no location.",
  "landmarks-empty": "A location declares no `landmarks`.",
  "landmark-invalid-id": "A landmark id is not a valid identifier.",
  "landmark-empty-name": "A landmark has an empty `name`.",
  "landmark-empty-description": "A landmark has an empty `description`.",
  "landmark-empty-prompt-depiction": "A landmark has an empty `promptDepiction`.",
  "landmark-id-conflict":
    "A landmark id is also a roster id, or a landmark id of another location.",
  "prompt-depiction-conflict":
    "One declared `promptDepiction` contains another, so a substring scan cannot tell them apart.",
  "setup-invalid-id": "A setup id is not a valid asset name.",
  "setup-empty-name": "A setup has an empty `name`.",
  "setup-empty-description": "A setup has an empty `description`.",
  "setup-empty": "A frame is declared with no setup roster to name.",
  "setup-unknown": "A frame names a setup that is not declared.",
  "setup-unknown-location": "A setup is set in a location that is not declared.",
  "holds-empty": "A setup other than an `insert` holds no landmark.",
  "holds-unknown-id": "A setup holds an id that is not a landmark of its location.",
  "within-undeclared": "A setup that could be cut from a wider one does not say whether it is.",
  "within-impossible": "A setup's `within` names a frame it could not be cut from.",
  "within-cyclic": "A setup's `within` chain leads back to itself.",
  "view-missing": "A setup that is no window declares no `view`.",
  "view-on-window": "A window declares a `view`, which it inherits.",
  "view-unknown": "A setup's `view` is not one of the four views.",
  "reference-id-conflict": "One id is declared in two rosters that share `reference:<id>`.",
  "script-empty-text": "A script line has an empty text or `acting` note.",
  "script-unknown-character": "A script line is spoken by an undeclared character.",
  "telop-empty-text": "A telop entry has empty text.",
  "aside-empty-label": "An aside has an empty `label`.",
  "lineup-missing": "A frame declares no `lineup`.",
  "lineup-unknown-id": "A lineup names an id in no roster.",
  "lineup-duplicate": "A lineup lists one subject twice.",
  "passing-overlap": "A subject is both passing and in an endpoint lineup.",
  "join-undeclared": "A boundary a long take could cross does not say whether it is one (`join`).",
  "join-impossible": "A `continuous` join sits at a boundary no unbroken take could cross.",
  "coverage-overdeclared": "A coverage shot declares a frame after its opening one.",
  "shot-span-mismatch":
    "A shot's span is not counted in the policy's unit: `beats` without `policy.song`, `duration` with it, or both.",
  "lyrics-without-song": "`lyrics` are declared with no `policy.song`.",
  "lyrics-singer-unknown": "A lyric singer is not a declared character.",
  "lyrics-singer-empty": "A lyric line is sung by nobody.",
  "lyrics-empty-line": "A lyric line has no words.",
};

type OtherCode = Exclude<FindingCode, DirectionFindingCode | DirectionErrorCode>;

// Where each is fixed, where the code alone does not say: a narration overflow one retime fits is
// fixed in `animatic.tsx`, the rest in `direction.ts`.
export const STAGE_FINDING_DOCS: Record<OtherCode, { flags: string; fixIn: string }> = {
  "prompt-negation": {
    flags: "A prompt names something to leave out.",
    fixIn: "the stage file or patch writing it",
  },
  "prompt-not-yet": {
    flags:
      "A prompt describes what has not happened: time talk in a still, or a state to hold where a motion prompt needs a move.",
    fixIn: "the stage file or patch writing it",
  },
  "prompt-double-negative": {
    flags: "A `negativePrompt` names an exclusion negatively, which cancels it.",
    fixIn: "the stage file or patch writing it",
  },
  "pin-unanchored": {
    flags: "A pin input takes a reference sheet or a plate instead of a frame of the picture.",
    fixIn: "the stage file or patch wiring it",
  },
  "class-font-family": {
    flags: "A `jsxImage`'s markup carries a class setting a font family.",
    fixIn: "the stage file",
  },
  "composition-class-font-family": {
    flags: "A shot's composition or the overlay carries a class setting a font family.",
    fixIn: "`animatic.tsx` / `video.tsx`",
  },
  "movement-unwritten": {
    flags:
      "A panel with a take has no `blocking` or `camera` — the transit out of its frame, written from the take.",
    fixIn: "`animatic.tsx`",
  },
  "take-silent": {
    flags:
      "A take awaiting review is silent, or a video owing a line has no audio track. Cleared by dismissing it or `konte vouch`.",
    fixIn: "the take's stage",
  },
  "line-misheard": {
    flags:
      "A take awaiting review does not say the line it owes, as heard. Cleared by dismissing it or `konte vouch`.",
    fixIn: "the take's stage",
  },
  "narration-overflow": {
    flags: "An animatic shot's lines run past its `duration`, so its stem's clamp cuts them.",
    fixIn: "`animatic.tsx` where one retime fits, else `direction.ts`",
  },
  "animatic-unconsumed": {
    flags: "A video shot spends without building on the board shot it develops.",
    fixIn: "`video.tsx`",
  },
  "script-unvoiced": {
    flags:
      "A shot the direction gives lines to plays no audio, or no `<Audio>` says one of its lines; on `policy.song` a video shot places none.",
    fixIn: "`animatic.tsx` / `video.tsx`",
  },
  "cutin-required": {
    flags: "A shot renders no `<Cutin>`, but the direction declares a `cutin` on it.",
    fixIn: "`animatic.tsx` / `video.tsx`",
  },
  "cutin-undeclared": {
    flags: "A shot renders a `<Cutin>`, but the direction declares no `cutin` on it.",
    fixIn: "`animatic.tsx` / `video.tsx`",
  },
  "plate-undeclared-setup": {
    flags: "A plate is filed under a key that is not a setup the direction declares.",
    fixIn: "`animatic.tsx`",
  },
  "soundtrack-anchor-unknown": {
    flags: "A soundtrack's `from` / `until` names a shot the timeline does not hold.",
    fixIn: "`animatic.tsx` / `video.tsx`",
  },
  "pending-reference": {
    flags:
      "An asset is built on a shot that is still a `pendingShot`; it and what is built on it wait, the rest of the stage spends.",
    fixIn: "the stage file writing the reference",
  },
};

const REACH_WORDS: Record<NonNullable<FindingTraits["holds"]["spend"]>["reach"], string> = {
  stage: "its stage",
  "stage+downstream": "its stage and downstream",
  downstream: "downstream",
  edge: "its assets and what is built on them",
};

// What a code holds. `stage` names the spend stages a direction finding fixed in `stage` reaches;
// the codes of other checks are stated by reach, their stage being the file of each instance.
function holdsOf(traits: FindingTraits, stage: Stage | null): string {
  const out: string[] = [];
  const spend = traits.holds.spend;
  if (spend) {
    const commands = spend.commands ? ` (${spend.commands.join(", ")})` : "";
    const where =
      stage === null ? REACH_WORDS[spend.reach] : spendStages(stage, spend.reach).join(", ");
    out.push(`spend: ${where}${commands}`);
  }
  if (traits.holds.accept) out.push("accept");
  if (traits.holds.preview) out.push("preview");
  return out.length > 0 ? out.join("; ") : "—";
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

// Passed through oxfmt, so the file is already what `oxfmt --check` expects and the tables read
// aligned; the test compares the formatted text.
export async function renderFindingsDoc(): Promise<string> {
  const { code, errors } = await format("docs/FINDINGS.md", renderFindingsMarkdown());
  if (errors.length > 0)
    throw new Error(`oxfmt failed on the findings list: ${JSON.stringify(errors)}`);
  return code;
}

function renderFindingsMarkdown(): string {
  const lines: string[] = [
    "# Findings",
    "",
    "<!-- Generated from src/core/findings-doc.ts by `bun run build:generate-findings-doc`. Do not edit by hand: src/core/__tests__/findings-doc.test.ts fails when this file and the code disagree. -->",
    "",
    "Every machine finding konte reports, by what it reads, how it clears, what it holds and when it sets in. `konte status` prints every one standing under `Findings`, grouped by the file it is fixed in.",
    "",
    "- **Reads** — `definition`: the definitions alone; `take`: a landed take too.",
    "- **Clears** — `fix`: only by fixing it; `waive`: by a reason in `direction.waivers`, which the human signs on the direction page; `vouch`: by `konte vouch` on the take, once heard.",
    "- **Holds** — `spend`: `generate` / `reroll` / `patch apply` / `export` on the stages named (`SPEND_HELD`); `accept`: the accept of what it sits on; `preview`: `konte preview` of its stage (both `REVIEW_HELD`).",
    "- **Onset** — `always`; `after-direction-accepted`: silent until the direction is accepted; `after-take`: owed once the take it is written from lands.",
    "",
    "## Direction findings",
    "",
    "Reported by the direction check over `direction.ts` and the stages built on it. A waiver is keyed `<code>` or `<code>_<subject>`; on a child sequence's own arc, a role subject (or none) is prefixed with the sequence id: `missing-role_<sequenceId>.<role>`, `no-payoff_<sequenceId>`. **Type-level**: a literal value is also a type error, so it stops at the startup type-check; a computed value reaches the finding instead.",
    "",
    ...table(
      ["Code", "Flags", "Waiver subject", "Fix in", "Reads", "Clears", "Holds", "Onset"],
      DIRECTION_FINDING_CODES.map((code) => {
        const doc = DIRECTION_FINDING_DOCS[code];
        const traits = findingTraits(code);
        const stage = findingFixStage(code);
        return [
          `\`${code}\``,
          doc.typeLevel ? `${doc.flags} Type-level.` : doc.flags,
          traits.clears === "waive" ? (doc.subject ?? "—") : "—",
          `\`${STAGE_ENTRY_FILE[stage]}\``,
          traits.reads,
          traits.clears,
          holdsOf(traits, stage),
          traits.onset,
        ];
      }),
    ),
    "",
    "## Direction structure",
    "",
    `Definition errors in \`direction.ts\`, each fixed there. Every one reads the definition, clears by a fix, holds ${holdsOf(findingTraits("duplicate-id"), "direction")} of the part it sits on, and is always reported.`,
    "",
    ...table(
      ["Code", "Flags"],
      (Object.keys(DIRECTION_ERROR_DOCS) as DirectionErrorCode[]).map((code) => [
        `\`${code}\``,
        DIRECTION_ERROR_DOCS[code],
      ]),
    ),
    "",
    "## Stage and take findings",
    "",
    "Reported over what a stage file or a patch script declares, and over the takes that landed.",
    "",
    ...table(
      ["Code", "Flags", "Fix in", "Reads", "Clears", "Holds", "Onset"],
      (Object.keys(STAGE_FINDING_DOCS) as OtherCode[]).map((code) => {
        const doc = STAGE_FINDING_DOCS[code];
        const traits = findingTraits(code);
        return [
          `\`${code}\``,
          doc.flags,
          doc.fixIn,
          traits.reads,
          traits.clears,
          holdsOf(traits, code === "animatic-unconsumed" ? "video" : null),
          traits.onset,
        ];
      }),
    ),
    "",
  ];
  return lines.join("\n");
}
