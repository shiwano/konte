import { format } from "oxfmt";
import type { Stage } from "./address.js";
import type { DirectionFindingCode } from "./direction-check.js";
import {
  type DirectionFindingClass,
  type SpendCommand,
  classifyDirectionFinding,
  gatedClasses,
  isDeferredUntilAcceptedFinding,
  findingFixStage,
} from "./direction.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import type { StageFindingCode } from "./waiver-keys.js";

// The source of `docs/FINDINGS.md`. Each record is keyed by the finding code set, so a new code with
// no entry here is a compile error, and `findings-doc.test.ts` fails until the document is
// regenerated (`bun run build:generate-findings-doc`). Only what the code cannot say is written by
// hand; the class, the gates, deferral and where the fix lives are read off the checks themselves.

type DirectionFindingDoc = {
  flags: string;
  // What the `_<subject>` half of the waiver key names; `null` where the key is the code alone.
  subject: string | null;
  // A literal value is also refused by the type layer (`ConstrainIds`, `StageChain`).
  typeLevel?: true;
};

export const DIRECTION_FINDING_DOCS: Record<DirectionFindingCode, DirectionFindingDoc> = {
  "missing-beat": { flags: "A role its lens requires has no item.", subject: "role" },
  "no-payoff": { flags: "No item takes the lens's payoff role.", subject: null },
  "beat-out-of-order": {
    flags: "A role appears before one its lens places earlier.",
    subject: "role that arrived early",
  },
  "lens-role-mismatch": {
    flags: "An item's role is not one its node's lens declares.",
    subject: "item id",
    typeLevel: true,
  },
  "too-many-consecutive": {
    flags: "More items of one role in a row than its `maxConsecutive`.",
    subject: "role",
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
  "beat-overweight": {
    flags: "A role holds more of the runtime than its `maxShare`.",
    subject: "role",
  },
  "beat-underweight": {
    flags: "A role holds less of the runtime than its `minShare`.",
    subject: "role",
  },
  "stage-order-mismatch": {
    flags: "A stage realizes the direction's shots in a different order.",
    subject: null,
    typeLevel: true,
  },
  unrealized: {
    flags: "A direction shot that no stage shot realizes.",
    subject: "shot id",
    typeLevel: true,
  },
  "character-unreferenced": {
    flags: "A character has no `reference:<id>` asset.",
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
  "setup-indistinct": {
    flags: "Two setups declare the same location, framing and `holds` order.",
    subject: "setup id (the later one)",
  },
  "setup-atomized": {
    flags: "A location holds many shots but almost none share a frame.",
    subject: "location id",
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
    flags: "A shot's duration is not a positive multiple of 0.5s.",
    subject: "shot id",
    typeLevel: true,
  },
  "undeclared-continuity": {
    flags:
      "Adjacent shots cut between two set-showing sizes of one location with no `within` declared.",
    subject: "id pair (`05-06`)",
  },
  "re-established-wide": {
    flags: "A shot re-establishes a location already shown wide.",
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
  "character-unconsumed": {
    flags: "A keyframe framing a character is built from no reference to them.",
    subject: "`<frame>.<characterId>`",
  },
  "slot-order-mismatch": {
    flags: "A keyframe passes its reference images in an order its `lineup` does not declare.",
    subject: "frame",
  },
  "plate-undescribed": {
    flags: "A shot on a plated setup carries no `plates.<id>.prompt` in its prompt.",
    subject: "setup id",
  },
  "landmark-flipped": {
    flags: "Two setups of one location disagree on the left-to-right order of its landmarks.",
    subject: "setup id",
  },
  "subject-unnamed": {
    flags:
      "No prompt behind a keyframe contains the `promptDepiction` of a subject it frames, verbatim (case-insensitive).",
    subject: "`<frame>.<characterId>`",
  },
  "plate-unnamed": {
    flags: "A plate's sentence omits a landmark its setup's `holds` declares.",
    subject: "`<setupId>.<landmarkId>`",
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
  "panel-unlinked": {
    flags:
      "A keyframe opening a cut along one `within` axis, on a model that reads a previous panel (`readsPrevPanel`), takes no previous panel, or another frame, among its image inputs. A cut between two frames whose lineups hold subjects but none in common is exempt.",
    subject: "seam (`<from>-<id>`, `.cutin` for a cutin)",
  },
};

export const STAGE_FINDING_DOCS: Record<StageFindingCode, { flags: string }> = {
  "prompt-negation": { flags: "A prompt names something to leave out." },
  "prompt-not-yet": {
    flags:
      "A prompt describes what has not happened: time talk in a still, or a state to hold where a motion prompt needs a move.",
  },
  "prompt-double-negative": {
    flags: "A `negativePrompt` names an exclusion negatively, which cancels it.",
  },
  "pin-unanchored": {
    flags: "A pin input takes a reference sheet or a plate instead of a frame of the picture.",
  },
};

const CLASS_ORDER: readonly DirectionFindingClass[] = [
  "arc",
  "pacing",
  "stage",
  "completeness",
  "characters",
  "props",
  "locations",
  "setups",
  "staging",
  "typesetting",
];

const SPEND_COMMANDS: readonly SpendCommand[] = ["generate", "reroll", "patch", "export"];
const SPEND_STAGES: readonly Stage[] = ["animatic", "video"];

function gatesOf(cls: DirectionFindingClass): string {
  const gated = SPEND_COMMANDS.flatMap((command) =>
    SPEND_STAGES.filter((stage) => gatedClasses(command, stage).has(cls)).map(
      (stage) => `\`${command}\` (${stage})`,
    ),
  );
  return gated.length === SPEND_COMMANDS.length * SPEND_STAGES.length
    ? "every spend"
    : gated.join(", ");
}

function fixNote(code: DirectionFindingCode): string | null {
  const stage = findingFixStage(code);
  return stage === "direction" ? null : `Fix in \`${STAGE_ENTRY_FILE[stage]}\``;
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
  const codes = Object.keys(DIRECTION_FINDING_DOCS) as DirectionFindingCode[];
  const lines: string[] = [
    "# Findings",
    "",
    "<!-- Generated from src/core/findings-doc.ts by `bun run build:generate-findings-doc`. Do not edit by hand: src/core/__tests__/findings-doc.test.ts fails when this file and the code disagree. -->",
    "",
    "Every machine finding konte reports. An unwaived one aborts a spend; clearing it means fixing it, or waiving it with the reason it is right, which a reviewer reads.",
    "",
    "## Direction findings",
    "",
    "Reported by the direction check over `direction.ts` and the stages built on it. An unwaived one aborts a spend with `DIRECTION_CHECK_FAILED`. A waiver sits in the `waivers` of the arc node the finding fired on, keyed `<code>` or `<code>_<subject>`.",
    "",
    "- **Deferred** — silent until the direction is accepted.",
    "- **Fix in `reference.tsx`** — the roster entry is right; a reference asset is missing.",
    "- **Fix in `animatic.tsx`** — the setup is right; its plate or a keyframe's input is missing or misbuilt.",
    "- **Type-level** — a literal value is also a type error, so it stops at the startup type-check; a computed value reaches the finding instead.",
  ];

  for (const cls of CLASS_ORDER) {
    const inClass = codes.filter((code) => classifyDirectionFinding(code) === cls);
    if (inClass.length === 0) continue;
    const deferred = inClass.every(isDeferredUntilAcceptedFinding);
    lines.push(
      "",
      `### ${cls} (${inClass.length})`,
      "",
      `Gates: ${gatesOf(cls)}.${deferred ? " Deferred." : ""}`,
      "",
      ...table(
        ["Code", "Flags", "Waiver subject", "Notes"],
        inClass.map((code) => {
          const doc = DIRECTION_FINDING_DOCS[code];
          const notes = [fixNote(code), doc.typeLevel ? "Type-level" : null].filter(
            (note) => note !== null,
          );
          return [`\`${code}\``, doc.flags, doc.subject ?? "—", notes.join(", ") || "—"];
        }),
      ),
    );
  }

  lines.push(
    "",
    "## Stage findings",
    "",
    "Reported over the prompt and pin inputs a stage or a patch declares. An unwaived prompt finding aborts a spend with `PROMPT_CHECK_FAILED`, a pin finding with `PIN_CHECK_FAILED`. A waiver sits in the `waivers` of `defineReference`, `defineAnimatic` or `defineVideo`, keyed `<code>:<hash>` as `konte status` prints it.",
    "",
    ...table(
      ["Code", "Flags"],
      (Object.keys(STAGE_FINDING_DOCS) as StageFindingCode[]).map((code) => [
        `\`${code}\``,
        STAGE_FINDING_DOCS[code].flags,
      ]),
    ),
    "",
  );
  return lines.join("\n");
}
