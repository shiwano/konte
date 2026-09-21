import {
  DIRECTION_SECTIONS,
  type DirectionSection,
  directionSectionOf,
  matchesAddressScope,
} from "../../core/address.js";
import { assertNever } from "../../core/assert.js";
import {
  checkDirection,
  classifyDirectionFinding,
  directionWaiverKey,
  reportableDirectionFindings,
} from "../../core/direction.js";
import {
  type DirectionPartStatus,
  directionAcceptanceView,
  summarizeDirectionAcceptance,
} from "../../core/direction-acceptance.js";
import { directionPartHashes } from "../../core/direction-hash.js";
import { type DirectionPartContent, directionPartContents } from "../../core/direction-parts.js";
import type { Direction } from "../../core/dsl/direction.js";
import { KonteError } from "../../core/errors.js";
import { FeedbackManager, feedbackStaleness } from "../../core/feedback/index.js";
import { StateManager } from "../../core/state/index.js";
import { scriptLinesToView } from "../../core/types/script.js";
import {
  loadDirectionIfPresent,
  loadAnimaticSetupState,
  loadStagingStageState,
} from "../load-definition.js";
import { loadReference } from "../../core/loader.js";
import { type FeedbackView, feedbackLine, feedbackTag, printFeedback } from "./inspect-feedback.js";

// `konte inspect direction` — the direction as a target rather than a review page. The direction
// stage holds no assets, so where an asset scope reports variants and staleness this reports the
// unit the stage actually has: its reviewable parts, each with the human's verdict on it, the
// feedback written on it, and (at part scope) the words being reviewed.
//
// A part scope names either one part or the prefix over several (`direction:brief`,
// `direction:characters`), and the words come out either way — so reading a section of the
// direction is one command, and no section needs one of its own.

interface PartEntry {
  address: string;
  section: DirectionSection;
  status: DirectionPartStatus | "orphan";
  acceptedAt: string | null;
  content: DirectionPartContent | null;
  feedback: FeedbackView[];
}

export async function inspectDirection(videoRoot: string, scope: string | null): Promise<void> {
  const direction = await loadDirectionIfPresent(videoRoot);
  if (!direction) {
    throw new KonteError("ADDRESS_NOT_FOUND", "No direction.ts found in the video root");
  }

  const manager = await StateManager.load(videoRoot);
  const acceptance = manager.getDirectionAcceptance();
  const view = directionAcceptanceView(direction, acceptance);
  const contents = directionPartContents(direction);
  const state = manager.getState();
  const subjectHashes = directionPartHashes(direction);
  const feedbackMgr = await FeedbackManager.load(videoRoot, "direction");

  const feedbackOf = (address: string): FeedbackView[] =>
    feedbackMgr.getFeedback(address).map((entry) => ({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      staleness: feedbackStaleness(entry, address, state, { subjectHashes }),
    }));

  const entryOf = (address: string, status: PartEntry["status"]): PartEntry => ({
    address,
    section: directionSectionOf(address),
    status,
    acceptedAt: acceptance?.parts[address]?.acceptedAt ?? null,
    content: contents.get(address) ?? null,
    feedback: feedbackOf(address),
  });

  if (scope !== null) {
    // An exact part first: a scope that IS a part reports that part, even where parts nest under it
    // (`direction:sequence` is the root arc as well as the prefix over every shot).
    const status = view.parts.get(scope);
    if (status !== undefined || view.orphans.includes(scope)) {
      const entry = entryOf(scope, status ?? "orphan");
      printPart(entry, direction);
      return;
    }

    const entries = [
      ...[...view.parts]
        .filter(([address]) => matchesAddressScope(address, scope))
        .map(([address, partStatus]) => entryOf(address, partStatus)),
      ...view.orphans
        .filter((address) => matchesAddressScope(address, scope))
        .map((address) => entryOf(address, "orphan")),
    ];
    if (entries.length === 0) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `No direction part matches "${scope}" (run "konte inspect direction" to list them)`,
      );
    }
    console.log(`Scope: ${scope}`);
    console.log(`Parts: ${entries.length}`);
    for (const entry of entries) {
      console.log("");
      printPartInList(entry, direction);
    }
    return;
  }

  // Only a finding a person can act on: a roster finding before the direction is accepted is
  // premature (see reportableDirectionFindings), and the reference pool is what the roster is
  // checked against — a missing/broken reference.tsx leaves it empty rather than failing the read.
  const reference = await loadReference(videoRoot).catch(() => null);
  const check = checkDirection(direction, {
    referenceAssetNames: reference?.exposedAssetNames ?? [],
    animaticSetups: await loadAnimaticSetupState(videoRoot, direction),
    stagingStage: await loadStagingStageState(videoRoot, direction),
  });
  const findings = reportableDirectionFindings(check.active, view.gateSatisfied).map((f) => ({
    key: directionWaiverKey(f),
    class: classifyDirectionFinding(f.code),
    message: f.message,
  }));

  const parts = [...view.parts].map(([address, status]) => entryOf(address, status));
  // An accepted part that left the direction is invisible in the live part set, so it is listed
  // rather than dropped — it still holds the gate shut in the piece-wide sections, and elsewhere it
  // is a record awaiting the next write's sweep.
  const orphans = view.orphans.map((address) => entryOf(address, "orphan"));

  const summary = summarizeDirectionAcceptance(direction, acceptance);

  console.log("Stage: direction");
  console.log(`Acceptance: ${acceptanceLine(summary)}`);

  if (check.structureErrors.length > 0) {
    console.log("");
    console.log(`Structural errors: ${check.structureErrors.length}`);
    for (const e of check.structureErrors) console.log(`  [${e.code}] ${e.message}`);
  }
  if (findings.length > 0) {
    console.log("");
    console.log(`Findings: ${findings.length}`);
    for (const f of findings) console.log(`  [${f.key}] (${f.class}) ${f.message}`);
  }

  const width = [...parts, ...orphans].reduce((max, p) => Math.max(max, p.address.length), 0);
  for (const section of DIRECTION_SECTIONS) {
    const sectionParts = parts.filter((p) => p.section === section);
    if (sectionParts.length === 0) continue;
    console.log("");
    console.log(`${section}: ${view.sections.get(section) ?? "accepted"}`);
    for (const p of sectionParts) console.log(`  ${partLine(p, width)}`);
  }
  if (orphans.length > 0) {
    console.log("");
    console.log("Orphans (accepted, no longer in the direction):");
    for (const p of orphans) console.log(`  ${partLine(p, width)}`);
  }
}

function acceptanceLine(summary: ReturnType<typeof summarizeDirectionAcceptance>): string {
  switch (summary.status) {
    case "accepted":
      return `accepted (${summary.total} parts)`;
    case "partial":
      return summary.gateBlocking > 0
        ? `partial — ${summary.gateBlocking} of ${summary.total} parts need review (${summary.blocking} not at their accepted hash)`
        : `accepted — ${summary.blocking} of ${summary.total} parts changed since, none blocking`;
    case "unaccepted":
      return `unaccepted (${summary.total} parts)`;
  }
}

function partLine(part: PartEntry, width: number): string {
  return `${part.address.padEnd(width)}  ${part.status}${feedbackTag(part.feedback)}`;
}

function printPart(part: PartEntry, direction: Direction): void {
  console.log(`Address: ${part.address}`);
  console.log(`Section: ${part.section}`);
  const accepted = part.acceptedAt ? ` (accepted ${part.acceptedAt})` : "";
  console.log(`Acceptance: ${part.status}${accepted}`);

  if (part.content) {
    console.log("");
    printContent(part.content, direction, { label: true });
  }

  printFeedback(part.feedback);
}

// One part inside a scope listing. The address heads the block, so the content drops the label that
// would restate it — reading a section is a read of its words, not of six copies of its scaffolding.
function printPartInList(part: PartEntry, direction: Direction): void {
  console.log(`${part.address}  ${part.status}${feedbackTag(part.feedback)}`);
  if (part.content) printContent(part.content, direction, { label: false });
  for (const entry of part.feedback) {
    if (entry.staleness !== "stale") console.log(feedbackLine(entry));
  }
}

function printContent(
  content: DirectionPartContent,
  direction: Direction,
  opts: { label: boolean },
): void {
  const heading = (text: string): void => {
    if (opts.label) console.log(text);
  };
  switch (content.kind) {
    case "brief":
      heading(`Brief: ${content.field}`);
      if (content.items) {
        if (content.items.length === 0) console.log("  none");
        for (const item of content.items) console.log(`  - ${item}`);
      } else {
        console.log(`  ${content.text}`);
      }
      return;
    case "format":
      heading("Policy: format");
      console.log(`  Fps:      ${content.fps}`);
      console.log(`  Base:     ${content.base.width}x${content.base.height}`);
      if (content.delivery) {
        console.log(`  Delivery: ${content.delivery.width}x${content.delivery.height}`);
      }
      return;
    case "lang":
      heading("Policy: lang");
      console.log(`  ${content.lang}`);
      return;
    case "fonts":
      heading("Policy: fonts");
      console.log(`  ${content.fonts.length > 0 ? content.fonts.join(", ") : "(none declared)"}`);
      return;
    case "speech":
      heading("Policy: speech");
      console.log(`  ${content.speech}`);
      return;
    case "roster":
      heading(`Roster: ${content.roster}.${content.id}`);
      console.log(`  Name:        ${content.name}`);
      if (content.promptDepiction) console.log(`  Prompt depiction: ${content.promptDepiction}`);
      console.log(`  Description: ${content.description}`);
      console.log(`  Reference:   reference:${content.id}`);
      for (const landmark of content.landmarks ?? []) {
        console.log(
          `  Landmark:    ${landmark.name} (${landmark.id}) — "${landmark.promptDepiction}" — ${landmark.description}`,
        );
      }
      return;
    case "setup":
      heading(`Setup: ${content.id}`);
      console.log(`  Name:        ${content.name}`);
      console.log(`  Description: ${content.description}`);
      console.log(`  Location:    ${content.location}`);
      console.log(`  Framing:     ${content.framing}`);
      console.log(`  Holds:       ${content.holds.join(" | ") || "(nothing — an insert)"}`);
      console.log(
        `  Within:      ${content.within === undefined ? "(not declared)" : (content.within ?? "(root of its own camera axis)")}`,
      );
      console.log(`  Plate:       animatic:plate.${content.id}`);
      return;
    case "voice":
      heading(`Voice: ${content.characterId ?? "narrator"}`);
      if (content.name) console.log(`  Character:   ${content.name}`);
      console.log(`  Description: ${content.description}`);
      console.log(`  Reference:   reference:${content.assetId}`);
      return;
    case "sequence":
      heading(`Sequence: ${content.id ?? "(root)"}`);
      if (content.role) console.log(`  Role:     ${content.role}`);
      if (content.synopsis) console.log(`  Synopsis: ${content.synopsis}`);
      console.log(`  Lens:     ${content.lens}`);
      console.log(`  Pleasure: ${content.pleasure}`);
      console.log(`  Children: ${content.children.join(", ") || "none"}`);
      return;
    case "shot":
    case "graphic": {
      heading(`${content.kind === "graphic" ? "Graphic shot" : "Shot"}: ${content.id}`);
      console.log(`  Role:     ${content.role}`);
      if (content.kind === "shot") {
        const setup = direction.setups?.[content.setup];
        console.log(`  Setup:    ${content.setup}`);
        if (setup) {
          console.log(`  Framing:  ${setup.framing}`);
          console.log(`  Location: ${setup.location}`);
        }
      }
      if (content.cutin) {
        const lineup = content.cutin.lineup.join(" | ") || "(no one)";
        const to =
          content.cutin.lineupTo.length > 0 ? ` → ${content.cutin.lineupTo.join(" | ")}` : "";
        const join = content.cutin.join ? ` (join: ${content.cutin.join})` : "";
        console.log(`  Cutin:    ${content.cutin.setup} — ${lineup}${to}${join}`);
      }
      console.log(`  Duration: ${content.duration}s`);
      console.log(`  Action:   ${content.action}`);
      const characterNameById = new Map(
        Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
      );
      const lines = scriptLinesToView(content.script, characterNameById);
      if (lines.length > 0) {
        console.log("  Script:");
        for (const line of lines) {
          console.log(
            `    ${line.speaker === null ? "(narration)" : `${line.speaker}:`} ${line.text}`,
          );
        }
      }
      if (content.telop.length > 0) {
        console.log("  Telop:");
        for (const text of content.telop) console.log(`    ${text}`);
      }
      return;
    }
    case "aside": {
      heading(`Aside: ${content.id}`);
      console.log(`  Label:    ${content.label}`);
      console.log(`  Duration: ${content.duration}s`);
      if (content.telop.length > 0) {
        console.log("  Telop:");
        for (const text of content.telop) console.log(`    ${text}`);
      }
      return;
    }
    case "waiver":
      heading(`Waiver: ${content.key}`);
      console.log(`  Reason: ${content.reason}`);
      return;
    default:
      assertNever(content, "printContent");
  }
}
