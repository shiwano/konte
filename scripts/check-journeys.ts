import { execFileSync } from "node:child_process";

// Guards the *chain-level* token load of what an agent reads: per journey,
// every file it loads end to end while doing its job. Each file can pass its
// per-file budget (skills:check) while the journey as a whole crowds out the
// context — this is the check for that.
//
// Two families, each charged its own always-loaded `AGENTS.md` (`CLAUDE.md` is
// the `@AGENTS.md` pointer). DEV prints first and SHIPPED last, so the numbers
// left on screen are the ones that reach users.
//
// SHIPPED — what a user's agent loads in their konte project.
// - `video` — the template skills loaded driving one video from reference →
//   animatic → video → export. The chain is the fixed, always-loaded set;
//   per-model and per-backend docs (one of each loads per project, ~2-3k
//   tokens) are headroom inside the budget, not listed.
// - `konte-direction-critic` / `konte-prompt-critic` — a subagent contract, loaded whole
//   on every spawn. Its "Read only this" rules bar skills and records, so
//   contract plus `AGENTS.md` is the whole fixed load; what it reads (the
//   direction, a stage file) is the variable part, in its own fresh context.
//
// DEV — what an agent working *on* konte loads, charged this repo's own
// `AGENTS.md`. One journey per kind of maintenance task, so the guides a task
// really opens together are budgeted together. Every dev skill must belong to
// at least one (enforced below) — an orphan is a guide nothing routes to.
//
// A budget may only be raised when its journey gains a genuinely new concept
// the agent has to learn, or when a human has been told why and agreed to the
// raise. Nothing else earns one: rewording, examples, sharper explanations of
// what is already there all have to fit by trimming prose elsewhere. Append every
// raise to the budget log below in the same `<journey> old → new: <the new concept>`
// form, one or two lines — a raise with no entry here is a regression that
// passed. A cut is logged the same way and drops that journey's older entries.
//
// Budget log:
// - video 42,850 → 37,000 (agreed by a human): cut to the measured load (36,935).
// - dev-render 10,050 → 10,150 (agreed by a human): source gain adjustments in arch-audio-guide;
//   submission uncertainty and resumable result retrieval in arch-jobs-guide.
// - dev-skills 10,250 → 11,900: Codex rollout analysis.
// - dev-direction 16,350 → 16,400 (agreed by a human): `join-impossible` is a compile error at the
//   `join` position (`ConstrainJoin` / `ConstrainCutinJoin`).
// - dev-direction 16,100 → 16,350, dev-render 10,000 → 10,050 (agreed by a human): a long take's
//   seam is one frame, the opening keyframe of the `join: "continuous"` shot (`join-unpinned`).
// - dev-comfy 9,900 → 9,950, dev-direction 15,400 → 16,100, dev-render 9,900 → 10,000,
//   dev-templates 5,950 → 6,000, dev-patch 8,500 → 8,550 (agreed by a human): the landmark
//   reference `animatic:landmark.<id>`, in AGENTS.md.
// - konte-prompt-critic 3,500 → 3,750: `landed-opening` — whether the shot's change is still ahead
//   of its opening keyframe.
// - every dev journey +350 (agreed by a human): AGENTS.md's Design Policy.
// - konte-direction-critic 3,050 → 3,950 (partly agreed by a human): the prompt check's roster
//   axis, figures no roster holds, reading `lineup` / `timeJump`, undivided motion, the declared
//   set, `join`.
// - konte-prompt-critic 2,650 → 3,500: spoken-line notation, a body's own left and right, the
//   `lineup` line, the occupied plate, the declared set.
// - konte-animatic-critic (new, 3,300) → 3,450: a viewer's read of one board sequence; the declared
//   set.

const WORKSPACE = "src/cli/templates/workspace";
const SKILLS = `${WORKSPACE}/dot.agents/skills`;
const AGENTS = "src/cli/templates/agents";
const DEV = ".claude/skills";

const ALWAYS = [`${WORKSPACE}/CLAUDE.md`, `${WORKSPACE}/AGENTS.md`];
const HOUSE_RULES = `${WORKSPACE}/HOUSE_RULES.md`;
const DEV_ALWAYS = ["CLAUDE.md", "AGENTS.md"];

const SHIPPED_JOURNEYS = [
  {
    name: "konte-direction-critic",
    budget: 3_950,
    files: [...ALWAYS, `${AGENTS}/konte-direction-critic.md`],
  },
  {
    name: "konte-prompt-critic",
    budget: 3_750,
    files: [...ALWAYS, `${AGENTS}/konte-prompt-critic.md`],
  },
  {
    name: "konte-animatic-critic",
    budget: 3_450,
    files: [...ALWAYS, `${AGENTS}/konte-animatic-critic.md`],
  },
  {
    name: "video",
    budget: 37_000,
    files: [
      ...ALWAYS,
      HOUSE_RULES,
      `${SKILLS}/konte-checkin/SKILL.md`,
      `${SKILLS}/drafting-guide/SKILL.md`,
      `${SKILLS}/layout-guide/SKILL.md`,
      `${SKILLS}/production-guide/SKILL.md`,
      `${SKILLS}/scenario-guide/SKILL.md`,
      `${SKILLS}/direction-guide/SKILL.md`,
      `${SKILLS}/direction-guide/references/rosters.md`,
      `${SKILLS}/direction-guide/references/camera.md`,
      `${SKILLS}/direction-guide/references/lineup.md`,
      `${SKILLS}/direction-guide/references/lenses.md`,
      `${SKILLS}/direction-guide/references/skeleton.md`,
      `${SKILLS}/direction-guide/references/cut-idioms.md`,
      `${SKILLS}/direction-guide/references/long-form.md`,
      `${SKILLS}/staging-guide/SKILL.md`,
      `${SKILLS}/staging-guide/references/plates.md`,
      `${SKILLS}/authoring-guide/SKILL.md`,
      `${SKILLS}/authoring-guide/references/delivery.md`,
      `${SKILLS}/prompt-guide/SKILL.md`,
      `${SKILLS}/generation-loop-guide/SKILL.md`,
      `${SKILLS}/review-guide/SKILL.md`,
      `${SKILLS}/composition-guide/SKILL.md`,
      `${SKILLS}/composition-guide/references/staging-patterns.md`,
      `${SKILLS}/composition-guide/references/audio-patterns.md`,
      `${SKILLS}/composition-guide/references/sound-design.md`,
      `${SKILLS}/polish-guide/SKILL.md`,
      `${SKILLS}/export-guide/SKILL.md`,
    ],
  },
];

const DEV_JOURNEYS = [
  // Adding or auditing a hosted-model adapter: the builder rules, then the
  // model's prompt guide and input descriptions that ship with it.
  {
    name: "dev-adapter",
    budget: 7_350,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/adapter-authoring/SKILL.md`,
      `${DEV}/prompt-guide-authoring/SKILL.md`,
    ],
  },
  // Re-emitting a bundled ComfyUI adapter. The dev skill @-includes the shipped
  // one whole, so the template SKILL.md and both its references are charged here.
  {
    name: "dev-comfy",
    budget: 9_950,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/konte-comfy-workflow/SKILL.md`,
      `${SKILLS}/konte-comfy-workflow/SKILL.md`,
      `${SKILLS}/konte-comfy-workflow/references/rename-conventions.md`,
      `${SKILLS}/konte-comfy-workflow/references/model-downloads.md`,
      `${DEV}/prompt-guide-authoring/SKILL.md`,
    ],
  },
  // The direction. Acceptance and comment staleness key off the same
  // part hashes, so the review guide comes along.
  {
    name: "dev-direction",
    budget: 16_400,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/arch-direction-guide/SKILL.md`,
      `${DEV}/arch-direction-guide/references/cascades.md`,
      `${DEV}/arch-review-system-guide/SKILL.md`,
    ],
  },
  // The render/export path — delivery upscales run as jobs, audio is muxed in
  // the same pass, and all of it shells out to the managed ffmpeg/Chromium.
  // The animatic rides along: it is the second stem and the second composition
  // the same render plan chooses between per shot.
  {
    name: "dev-render",
    budget: 10_150,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/arch-delivery-guide/SKILL.md`,
      `${DEV}/arch-jobs-guide/SKILL.md`,
      `${DEV}/arch-audio-guide/SKILL.md`,
      `${DEV}/arch-animatic-guide/SKILL.md`,
      `${DEV}/arch-managed-binaries-guide/SKILL.md`,
    ],
  },
  // Authoring konte's own knowledge files: the conventions, the quality bar,
  // and the session evidence that says whether a guide is really being read.
  {
    name: "dev-skills",
    budget: 11_900,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/agents-md-guide/SKILL.md`,
      `${DEV}/template-skills-guide/SKILL.md`,
      `${DEV}/konte-skill-quality-review/SKILL.md`,
      `${DEV}/konte-prose-trim/SKILL.md`,
      `${DEV}/konte-claude-session-analysis/SKILL.md`,
      `${DEV}/konte-codex-session-analysis/SKILL.md`,
    ],
  },
  // The init template tree — where a file goes, and the conventions for the
  // skills that ship inside it.
  {
    name: "dev-templates",
    budget: 6_000,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/arch-template-system-guide/SKILL.md`,
      `${DEV}/template-skills-guide/SKILL.md`,
    ],
  },
  // Correcting a single take. The lineage decides what is reviewable, so the
  // review model comes along.
  {
    name: "dev-patch",
    budget: 8_550,
    files: [
      ...DEV_ALWAYS,
      `${DEV}/arch-patch-guide/SKILL.md`,
      `${DEV}/arch-review-system-guide/SKILL.md`,
    ],
  },
  // Review-UI work: drive the SPA offline against a fixture, against the model
  // of what a review actually stores.
  {
    name: "dev-ui",
    budget: 7_900,
    files: [...DEV_ALWAYS, `${DEV}/konte-run/SKILL.md`, `${DEV}/arch-review-system-guide/SKILL.md`],
  },
  // Adding or changing a command: scope and root resolution, and the output
  // conventions an agent acts on.
  {
    name: "dev-cli",
    budget: 4_400,
    files: [...DEV_ALWAYS, `${DEV}/arch-cli-guide/SKILL.md`],
  },
];

// Shipped last on purpose: it is the family that reaches users, so it is the
// block still on screen when the check finishes.
const JOURNEYS = [...DEV_JOURNEYS, ...SHIPPED_JOURNEYS];

const out = execFileSync(
  "waza",
  [
    "--no-update-check",
    "tokens",
    "count",
    SKILLS,
    AGENTS,
    DEV,
    ...ALWAYS,
    HOUSE_RULES,
    ...DEV_ALWAYS,
  ],
  {
    encoding: "utf8",
  },
);

const tokensByFile = new Map<string, number>();
for (const line of out.split("\n")) {
  const m = line.trim().match(/^(\S+\.md)\s+(\d+)\s+\d+\s+\d+$/);
  if (m) tokensByFile.set(m[1]!, Number(m[2]));
}

let failed = false;

for (const journey of JOURNEYS) {
  process.stdout.write(`\n${journey.name}\n`);

  let total = 0;
  const missing: string[] = [];
  for (const file of journey.files) {
    const tokens = tokensByFile.get(file);
    if (tokens === undefined) {
      missing.push(file);
      continue;
    }
    total += tokens;
    const label = file
      .replace(`${SKILLS}/`, "")
      .replace(`${AGENTS}/`, "")
      .replace(`${WORKSPACE}/`, "")
      .replace(`${DEV}/`, "dev/");
    process.stdout.write(`${String(tokens).padStart(6)}  ${label}\n`);
  }

  if (missing.length > 0) {
    failed = true;
    process.stderr.write(
      `Journey "${journey.name}" files missing (renamed or deleted? update JOURNEYS in ${import.meta.url}):\n` +
        missing.map((f) => `  ${f}\n`).join(""),
    );
    continue;
  }

  process.stdout.write(`${String(total).padStart(6)}  total (budget ${journey.budget})\n`);
  if (total > journey.budget) {
    failed = true;
    process.stderr.write(
      `Journey "${journey.name}" over budget by ${total - journey.budget} tokens — cut or consolidate before shipping.\n`,
    );
  }
}

// Every shipped subagent and every dev skill must sit in a journey, or its
// tokens escape this check entirely. Template skills are exempt: the `video`
// chain is one route through them, not a roster of all of them.
const budgeted = new Set(JOURNEYS.flatMap((j) => j.files));
for (const [label, prefix] of [
  ["Shipped subagents", `${AGENTS}/`],
  ["Dev skills", `${DEV}/`],
] as const) {
  const orphans = [...tokensByFile.keys()]
    .filter((f) => f.startsWith(prefix))
    .filter((f) => !budgeted.has(f));
  if (orphans.length === 0) continue;
  failed = true;
  process.stderr.write(
    `\n${label} with no journey (add one to JOURNEYS in ${import.meta.url}):\n` +
      orphans.map((f) => `  ${f}\n`).join(""),
  );
}

if (failed) process.exit(1);
process.stdout.write("\nAll journeys within budget.\n");
