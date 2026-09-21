import { format } from "oxfmt";
import type { DirectionFinding, ShotPanels, VideoShotPins } from "./direction-check.js";
import { checkDirection, validateDirectionStructure, type StagingStageState } from "./direction.js";
import type { Direction, NarrativeShot, Setup, Shot } from "./dsl/direction.js";

// The source of `docs/SEAMS.md`: the boundary rules (`join`, the lineup across it, the previous
// panel, the video's pins) as the checker answers them over fixtures. Each row runs one direction, and the board
// or video state the rule reads, through `validateDirectionStructure` and `checkDirection`.
// `seam-doc.test.ts` fails until the document is regenerated (`bun run build:generate-seam-doc`).

// The codes a seam row reports. Everything else the fixture raises (arc shape, unused rosters) is
// outside the table.
const SEAM_CODES = new Set([
  "join-impossible",
  "join-undeclared",
  "join-lineup-mismatch",
  "join-unpinned",
  "join-unshown",
  "panel-unlinked",
  "lineup-flipped",
  "undeclared-continuity",
  "character-unconsumed",
]);

// One room with two landmarks; `wide` is the axis root, `medium` a step in from it, `reverse` a
// second camera in the same room on its own axis, `yard` another place.
const SETUPS: Record<string, Setup> = {
  wide: {
    name: "the room, wide",
    description: "the whole room from the door",
    location: "room",
    framing: "wide",
    holds: ["desk", "window"],
    within: null,
  },
  medium: {
    name: "the desk",
    description: "in on the desk",
    location: "room",
    framing: "medium",
    holds: ["desk"],
    within: "wide",
  },
  reverse: {
    name: "the window from the desk",
    description: "turned round, from the desk to the window",
    location: "room",
    framing: "medium",
    holds: ["window"],
    within: null,
  },
  yard: {
    name: "the yard",
    description: "the yard from the back step",
    location: "yard",
    framing: "wide",
    holds: ["gate"],
  },
};

function direction(shots: readonly Shot[]): Direction {
  return {
    brief: { logline: "a seam" },
    characters: {
      a: { name: "Ann", promptDepiction: "the woman", description: "the woman" },
      b: { name: "Bo", promptDepiction: "the boy", description: "the boy" },
    },
    locations: {
      room: {
        name: "the room",
        description: "a small room",
        landmarks: {
          desk: { name: "the desk", promptDepiction: "desk", description: "a desk" },
          window: { name: "the window", promptDepiction: "window", description: "a window" },
        },
      },
      yard: {
        name: "the yard",
        description: "a back yard",
        landmarks: { gate: { name: "the gate", promptDepiction: "gate", description: "a gate" } },
      },
    },
    setups: SETUPS,
    policy: {
      format: { fps: 24, size: { megapixels: 0.5, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
    },
    sequence: { lens: "mini-drama", pleasure: "cute", shots: [...shots] },
  } as unknown as Direction;
}

const shot = (id: string, setup: string, extra: Partial<NarrativeShot> = {}): Shot =>
  ({
    id,
    role: "ordinary",
    action: "a shot",
    setup,
    duration: 3,
    lineup: ["a"],
    ...extra,
  }) as Shot;
const aside = (id: string): Shot =>
  ({ kind: "aside", id, label: "eyecatch", duration: 2 }) as unknown as Shot;
const graphic = (id: string): Shot =>
  ({ kind: "graphic", id, role: "ordinary", action: "a card", duration: 2 }) as unknown as Shot;

const noStage: StagingStageState = {
  panelSlots: [],
  panelReach: [],
  plateUses: [],
  panelPrompts: [],
  platePrompts: {},
  videoPins: [],
  shotPanels: [],
};

const panelAddress = (shotId: string, name: string) => `animatic:shot.${shotId}.${name}`;

// A developed board shot: whether its opening keyframe's model reads a previous panel, and what it
// was handed of one.
function boarded(
  shotId: string,
  opts: { lane?: "main" | "cutin"; reads?: boolean; linked?: readonly string[] } = {},
): ShotPanels {
  return {
    shotId,
    lane: opts.lane ?? "main",
    firstPanel: panelAddress(shotId, "first"),
    lastPanel: panelAddress(shotId, "last"),
    carries: opts.reads ?? false,
    linked: [...(opts.linked ?? [])],
  };
}

// A developed video shot: the ends its model can pin, and what its end pin reaches.
function taken(
  shotId: string,
  opts: { slots?: readonly ("start" | "end")[]; end?: readonly string[] } = {},
): VideoShotPins {
  return {
    shotId,
    lane: "main",
    slots: opts.slots ?? ["start", "end"],
    pins: opts.end ? [{ pin: "end", reaches: [...opts.end] }] : [],
  };
}

type SeamCase = {
  title: string;
  direction: Direction;
  // Undefined: no stage was read, so the stage-side findings stay silent.
  stage?: StagingStageState;
  referenceAssetNames?: readonly string[];
};

type SeamSection = { title: string; intro: string; cases: readonly SeamCase[] };

const boardCase = (title: string, dir: Direction, shotPanels: readonly ShotPanels[]): SeamCase => ({
  title,
  direction: dir,
  stage: { ...noStage, shotPanels },
});

const videoCase = (
  title: string,
  dir: Direction,
  videoPins: readonly VideoShotPins[],
): SeamCase => ({
  title,
  direction: dir,
  stage: { ...noStage, shotPanels: [boarded("01"), boarded("02")], videoPins },
});

const longTake = direction([shot("01", "wide"), shot("02", "wide", { join: "continuous" })]);
const pushIn = direction([shot("01", "wide"), shot("02", "medium")]);

export const SEAM_SECTIONS: readonly SeamSection[] = [
  {
    title: "Declaring the boundary",
    intro:
      "`join` is the boundary INTO a shot. Omitted is an ordinary cut; `jump-back` / `jump-forward` are cuts that move story time; `continuous` is one unbroken take with the shot before it. A take can run on only from the shot just before on the clock, narrative, on the same setup: there the boundary must be declared, and nowhere else can it be `continuous`. Both are structural errors, never waived; a literal `continuous` written elsewhere is refused by the type layer first.",
    cases: [
      {
        title: "Same setup, nothing declared",
        direction: direction([shot("01", "wide"), shot("02", "wide")]),
      },
      { title: "Same setup, one take", direction: longTake },
      {
        title: "Same setup, a jump cut",
        direction: direction([shot("01", "wide"), shot("02", "wide", { join: "jump-forward" })]),
      },
      {
        title: "`continuous` across two setups",
        direction: direction([shot("01", "wide"), shot("02", "medium", { join: "continuous" })]),
      },
      {
        title: "`continuous` opening the piece",
        direction: direction([shot("01", "wide", { join: "continuous" })]),
      },
      {
        title: "`continuous` after an aside",
        direction: direction([
          shot("01", "wide"),
          aside("ec"),
          shot("02", "wide", { join: "continuous" }),
        ]),
      },
      {
        title: "`continuous` after a graphic shot",
        direction: direction([
          shot("01", "wide"),
          graphic("card"),
          shot("02", "wide", { join: "continuous" }),
        ]),
      },
      {
        title: "A cutin runs on from the cutin before it",
        direction: direction([
          shot("01", "wide", { cutin: { setup: "reverse", lineup: ["b"] } }),
          shot("02", "yard", {
            cutin: { setup: "reverse", lineup: ["b"], join: "continuous" },
          }),
        ]),
      },
      {
        title: "A cutin `continuous` where the shot before carries no cutin",
        direction: direction([
          shot("01", "wide"),
          shot("02", "yard", {
            cutin: { setup: "reverse", lineup: ["b"], join: "continuous" },
          }),
        ]),
      },
    ],
  },
  {
    title: "The lineup across the boundary",
    intro:
      "Who a frame holds, left to right, accumulates per place across ordinary cuts. A jump empties every place. One take has one frame at its seam, so the shot before's `lineupTo ?? lineup` must be the next shot's `lineup`.",
    cases: [
      {
        title: "One take, the seam agreed on",
        direction: direction([
          shot("01", "wide", { lineup: ["a"], lineupTo: ["b", "a"] }),
          shot("02", "wide", { lineup: ["b", "a"], join: "continuous" }),
        ]),
      },
      {
        title: "One take, the two shots wanting different frames",
        direction: direction([
          shot("01", "wide", { lineup: ["a"] }),
          shot("02", "wide", { lineup: ["b", "a"], join: "continuous" }),
        ]),
      },
      {
        title: "An ordinary cut reversing a pair",
        direction: direction([
          shot("01", "wide", { lineup: ["a", "b"] }),
          shot("02", "medium", { lineup: ["b", "a"] }),
        ]),
      },
      {
        title: "A jump reversing a pair",
        direction: direction([
          shot("01", "wide", { lineup: ["a", "b"] }),
          shot("02", "medium", { lineup: ["b", "a"], join: "jump-forward" }),
        ]),
      },
    ],
  },
  {
    title: "The board's frame across a cut along one axis",
    intro:
      "An omitted join between two setups sharing a `within` root: the opening keyframe takes the previous shot's last panel in one of its image inputs. Judged where both shots are on the board and the keyframe's model reads a previous panel (`readsPrevPanel`), unless both frames hold subjects and share none. A long take asks the board for nothing.",
    cases: [
      boardCase("Push in, handed the frame before", pushIn, [
        boarded("01"),
        boarded("02", { reads: true, linked: [panelAddress("01", "last")] }),
      ]),
      boardCase("Push in, handed no previous panel", pushIn, [
        boarded("01"),
        boarded("02", { reads: true }),
      ]),
      boardCase("Push in, handed another shot's frame", pushIn, [
        boarded("01"),
        boarded("02", { reads: true, linked: [panelAddress("07", "last")] }),
      ]),
      boardCase("Push in, a model that reads no previous panel", pushIn, [
        boarded("01"),
        boarded("02"),
      ]),
      boardCase("Push in, the shot before not yet on the board", pushIn, [
        boarded("02", { reads: true }),
      ]),
      boardCase(
        "Push in across a story-time jump",
        direction([shot("01", "wide"), shot("02", "medium", { join: "jump-forward" })]),
        [boarded("01"), boarded("02", { reads: true })],
      ),
      boardCase(
        "Push in from one subject to another",
        direction([shot("01", "wide", { lineup: ["a"] }), shot("02", "medium", { lineup: ["b"] })]),
        [boarded("01"), boarded("02", { reads: true })],
      ),
      boardCase("Two cameras in one room", direction([shot("01", "wide"), shot("02", "reverse")]), [
        boarded("01"),
        boarded("02", { reads: true }),
      ]),
      boardCase(
        "Push in with an aside between",
        direction([shot("01", "wide"), aside("ec"), shot("02", "medium")]),
        [boarded("01"), boarded("02", { reads: true })],
      ),
      boardCase("One take, handed no previous panel", longTake, [
        boarded("01"),
        boarded("02", { reads: true }),
      ]),
    ],
  },
  {
    title: "The video's frame across a long take",
    intro:
      "The seam of a long take is the opening keyframe of the shot that declares it. The video take before must pin its end to that frame. Judged where the take before is developed, the board holds the seam frame, and the take before's model has an end slot; the take after need not exist yet.",
    cases: [
      videoCase("The take before pins its end to the seam frame", longTake, [
        taken("01", { end: [panelAddress("02", "first")] }),
        taken("02"),
      ]),
      videoCase("The take before pins its end to a resize of the seam frame", longTake, [
        taken("01", { end: ["video:shot.01.seam", panelAddress("02", "first")] }),
        taken("02"),
      ]),
      videoCase("The take before pins its end to its own last panel", longTake, [
        taken("01", { end: [panelAddress("01", "last")] }),
        taken("02"),
      ]),
      videoCase("The take before pins nothing", longTake, [taken("01"), taken("02")]),
      videoCase("The take before's model has no end slot", longTake, [
        taken("01", { slots: ["start"] }),
        taken("02"),
      ]),
      videoCase("The take after not yet developed", longTake, [taken("01")]),
    ],
  },
  {
    title: "The shot before a long take",
    intro:
      "The shot before a long take authors no closing keyframe: its `lineupTo` is read against the next shot's first panel.",
    cases: [
      {
        title: "One take: the frame the `lineupTo` describes is the next shot's first panel",
        direction: direction([
          shot("01", "wide", { lineup: ["a"], lineupTo: ["a", "b"] }),
          shot("02", "wide", { lineup: ["a", "b"], join: "continuous" }),
        ]),
        stage: {
          ...noStage,
          panelReach: [
            {
              shotId: "01",
              lane: "main",
              panel: panelAddress("01", "first"),
              refs: ["a"],
              generative: true,
            },
            {
              shotId: "01",
              lane: "main",
              panel: panelAddress("01", "last"),
              refs: ["a"],
              generative: true,
            },
            {
              shotId: "02",
              lane: "main",
              panel: panelAddress("02", "first"),
              refs: ["a", "b"],
              generative: true,
            },
          ],
        },
        referenceAssetNames: ["a", "b"],
      },
      {
        title: "A cut: the `lineupTo` is the shot's own last panel",
        direction: direction([
          shot("01", "wide", { lineup: ["a"], lineupTo: ["a", "b"] }),
          shot("02", "wide", { lineup: ["a", "b"], join: "jump-forward" }),
        ]),
        stage: {
          ...noStage,
          panelReach: [
            {
              shotId: "01",
              lane: "main",
              panel: panelAddress("01", "first"),
              refs: ["a"],
              generative: true,
            },
            {
              shotId: "01",
              lane: "main",
              panel: panelAddress("01", "last"),
              refs: ["a"],
              generative: true,
            },
            {
              shotId: "02",
              lane: "main",
              panel: panelAddress("02", "first"),
              refs: ["a", "b"],
              generative: true,
            },
          ],
        },
        referenceAssetNames: ["a", "b"],
      },
    ],
  },
];

const short = (address: string) => address.replace(/^animatic:shot\./, "");

function describeDirection(dir: Direction): string {
  const shots = (dir.sequence as { shots: Shot[] }).shots;
  return shots
    .map((s) => {
      const kind = (s as { kind?: string }).kind;
      if (kind === "aside") return `${s.id} (aside)`;
      const parts: string[] = [];
      if (kind === "graphic") parts.push(`${s.id} (graphic)`);
      else {
        const n = s as NarrativeShot;
        parts.push(
          `${n.id} ${n.setup}${n.join ? ` \`${n.join}\`` : ""} [${n.lineup.join(",")}${n.lineupTo ? ` ⇒ ${n.lineupTo.join(",")}` : ""}]`,
        );
      }
      const cutin = (s as NarrativeShot).cutin;
      if (cutin) {
        parts.push(
          `cutin ${cutin.setup}${cutin.join ? ` \`${cutin.join}\`` : ""} [${cutin.lineup.join(",")}]`,
        );
      }
      return parts.join(" + ");
    })
    .join(" → ");
}

function describeBoard(stage: StagingStageState | undefined): string {
  if (!stage) return "none";
  const notes: string[] = [];
  const on = stage.shotPanels.map((p) => `${p.shotId}${p.lane === "cutin" ? ".cutin" : ""}`);
  if (on.length > 0) notes.push(`on the board: ${on.join(", ")}`);
  for (const p of stage.shotPanels) {
    if (!p.carries) continue;
    notes.push(
      p.linked.length === 0
        ? `${p.shotId} handed no previous panel`
        : `${p.shotId} previous panel ← ${p.linked.map(short).join(", ")}`,
    );
  }
  for (const r of stage.panelReach)
    notes.push(`${short(r.panel)} ← reference ${r.refs.join(", ")}`);
  return notes.length > 0 ? notes.join("; ") : "none";
}

function describeVideo(stage: StagingStageState | undefined): string {
  if (!stage || stage.videoPins.length === 0) return "none";
  const notes: string[] = [`developed: ${stage.videoPins.map((p) => p.shotId).join(", ")}`];
  for (const p of stage.videoPins) {
    const end = p.pins.find((pin) => pin.pin === "end");
    if (end) notes.push(`${p.shotId} end → ${end.reaches.map(short).join(" → ")}`);
    else if (!p.slots.includes("end")) notes.push(`${p.shotId} has no end slot`);
  }
  return notes.join("; ");
}

function describeResult(c: SeamCase): string {
  const errors = validateDirectionStructure(c.direction).filter((e) => SEAM_CODES.has(e.code));
  const findings = checkDirection(c.direction, {
    ...(c.stage ? { stagingStage: c.stage } : {}),
    ...(c.referenceAssetNames ? { referenceAssetNames: c.referenceAssetNames } : {}),
  }).active.filter((f: DirectionFinding) => SEAM_CODES.has(f.code));
  const cells = [
    ...errors.map((e) => `\`${e.code}\` (${e.subject}, error)`),
    ...findings.map((f) => `\`${f.code}\` (${f.subject})`),
  ];
  return cells.length > 0 ? cells.join(", ") : "none";
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function renderSeamMarkdown(): string {
  const lines: string[] = [
    "# Seams",
    "",
    "<!-- Generated from src/core/seam-doc.ts by `bun run build:generate-seam-doc`. Do not edit by hand: src/core/__tests__/seam-doc.test.ts fails when this file and the code disagree. -->",
    "",
    "What konte demands at the boundary between two shots (`join`, the lineup across it, the previous panel, the video's pins), as the checker answers it over fixtures. Every row is one direction, with the board or video state the rule reads, run through `validateDirectionStructure` and `checkDirection`; Result is what came back. An `error` is structural and never waived; the rest are findings, waived by key. Not shown: findings outside the boundary rules, and the load-time rules a stage file trips on its own (`ANIMATIC_INVALID` on a landing panel that declares movement).",
    "",
    'Fixtures: one room with `wide` (the axis root), `medium` (`within: "wide"`) and `reverse` (a second camera on its own axis), and `yard` in another place. `[a ⇒ b,a]` is a shot\'s `lineup` and `lineupTo`.',
  ];
  for (const section of SEAM_SECTIONS) {
    lines.push(
      "",
      `## ${section.title}`,
      "",
      section.intro,
      "",
      ...table(
        ["Case", "Direction", "Board", "Video", "Result"],
        section.cases.map((c) => [
          c.title,
          describeDirection(c.direction),
          describeBoard(c.stage),
          describeVideo(c.stage),
          describeResult(c),
        ]),
      ),
    );
  }
  return lines.join("\n") + "\n";
}

export async function renderSeamDoc(): Promise<string> {
  const { code, errors } = await format("docs/SEAMS.md", renderSeamMarkdown());
  if (errors.length > 0) throw new Error(`oxfmt failed on the seam doc: ${JSON.stringify(errors)}`);
  return code;
}
