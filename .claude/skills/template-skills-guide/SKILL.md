---
name: template-skills-guide
description: Conventions for authoring the skills konte ships into user projects. Read before adding, editing, or restructuring a template skill.
user-invocable: false
---

Conventions for the skills `konte workspace new` writes into every user project (under `src/cli/templates/workspace/dot.agents/skills/`, one dir per skill) — **not** this repo's own dev skills. A skill is done when it's single-purpose, terse-first, and passes `skills:check` + quality-review.

**Audience: the agent working in a user's konte project, mid-task** — not the konte maintainer editing this file, not the human. Write what that agent needs to act; never explain the doc's own structure or why content sits where it does.

- **Ship as managed files** (`.claude/skills/` in `MANAGED_PREFIXES`) — re-synced on `konte` upgrade, so a user's local edits are overwritten. Author here, never in a user project.
- Scarcity discipline matches `agents-md-guide` (read it for the project's own `AGENTS.md`).

## Single source, claude mirror

- **Author only under `dot.agents/skills/`** — embed (`scripts/embed-templates.ts`) mirrors each skill's `SKILL.md` and its `references/` verbatim to a `.claude/skills/` twin. Codex reads `dot.agents/skills/` directly; Claude Code reads the mirror.
- **Never touch `dot.claude/skills/`** — embed throws if it finds a hand-written `SKILL.md` there; only its `README.md` (ignored by embed) and the Claude-only `konte-lsp` plugin belong there.
- **Sidecars aren't mirrored** — only `SKILL.md` and `references/` are.
- **Plugin skills live in `plugin/plugins/konte/skills/`** — shipped by the marketplace, not `init`; no `konte-` prefix (the namespace supplies it). The plugin ships only `setup` and `upgrade`, which install and update the binary inside one workspace. `.github/workflows/publish-plugin.yml` (`workflow_dispatch` only for now) publishes `plugin/` to the orphan `plugin` branch users add (`shiwano/konte@plugin`), so main carries no marketplace at its root.

## Subagents

- **Single source: `src/cli/templates/agents/<name>.md`** — client-neutral frontmatter (`name`, `description`) over the instructions body. Embed generates `.claude/agents/<name>.md` and `.codex/agents/<name>.toml` (body → `developer_instructions`); a hand-written file under either path fails the build.
- **Critics are fresh-spawned, read-only, findings-only** — `konte-direction-critic` reads the direction, `konte-prompt-critic` the prompts, and `konte-animatic-critic` the board or plates.
- **The calling skill owns when to spawn and how to handle findings.**

## Naming

The directory name **is** the `name:`, split by kind:

- **User-invocable** (`user-invocable: true`) — available as a human slash-command. Name `konte-<verb/noun>` (`konte-checkin`, `konte-comfy-workflow`).
- **Agent-only** (`user-invocable: false`) — read by the agent when a task needs it. Name `<topic>-guide`, no prefix (`composition-guide`, `production-guide`).

## Frontmatter

```yaml
---
name: <matches the directory name>
description: <what it covers — when to read/use it>
user-invocable: true | false
argument-hint: <args> # optional, user-invocable skills that take an argument only
---
```

- **`description` is the whole routing signal** — all the agent sees when choosing whether to open the skill, and it loads every turn. State the coverage and the trigger **once**; a topic list followed by a "Read when…" list repeating it is the usual waste. Shape it _what it covers — when to reach for it_:
  - agent-only: `Read when adding, editing, or wiring shots and assets in a definition file.`
  - user-invocable: `Use when the user wants to "complete the animatic", generate or refine panels, or run the animatic stage.`
- **It is an unquoted YAML scalar** — ` #` starts a comment and silently truncates the rest; `: ` breaks the parse. Use an em dash, and never a space before a `#`.

## Body

Open every skill with one prose sentence that fixes its **scope and definition of done** — what "finished" means and what's explicitly out of scope. This opening sentence is the one prose exemption; everything after is terse-first.

- **Voice: terse-first** — one rule per line, not prose paragraphs. Keep the why as an inline clause (`**rule** — why`); cut narration, recap, hedging, "this is deliberate" asides. The aim is fewer tokens at the same effect — never drop a why or a judgment to save space.
- **Branches are routing lists, not prose** — write an if-X-then-Y fork as a `- symptom/state → destination` bullet list.
- **No markdown tables** — the formatter pads every cell, so a table costs more tokens than the same content as bullets. A row with N columns is one bullet: `- **key** (dimension; dimension) — the rest`.
- **Show the smallest correct DSL/CLI snippet**, don't narrate it; **bold** the load-bearing rule at the start of each line.

Choose a procedure or reference structure independently of `user-invocable`.

**Procedure skills** — ordered steps (`drafting-guide`, `layout-guide`, `generation-loop-guide`):

- **State the entry conditions** — check state or backend health when the task depends on it; route failures to the guide that resolves them.
- **State the completion condition and what to report or hand off** — use a verification command when completion can be checked by one; a chat report can itself be the result.
- **State approval boundaries and exclusions where needed** — use `## Confirm before` / `## Don't` when they need a separate section.
- Surface costly/destructive choices to the human rather than guessing.

**Reference skills** — organized by topic (`composition-guide`, `authoring-guide`):

- **Lead with `## Routing`** (a `- X → destination` list, see authoring-guide's "Routing") when the skill exists to make a choice, so the agent lands fast.
- **Catalog patterns/recipes** under their own subheadings (composition-guide's `references/staging-patterns.md`), each with the smallest correct snippet.
- **Close with `## Pitfalls`** (each mistake + its fix) and a `## Verify` step (the cheap command that confirms the work) where they apply.

Across both:

- **A "before every X" rule lives in the skill that owns X** — a skill is read once per session, so a recurring directive parked upstream fires wherever the agent happened to be reading and stays silent at the X that mattered.
- **One owner per rule** — every rule lives in exactly one skill; a sibling that needs it routes there by name (`read the staging-guide skill`), never restates it. Chain-level duplication is what blows the journey budget even when every file passes its own. Carve a guide out when two skills would repeat the same material.
- **The residue test** — before shipping a line, ask: would the _executing_ agent act differently without it? Context you held while writing — design history, what a sibling already covers, reassurance, restated names/types — fails the test; cut it. Keep the why and judgment that change what the agent does.
- **Keep the shipped `AGENTS.md` minimal** — it loads every turn. Push first-time/conditional knowledge into a `*-guide` and leave a one-line pointer; only always-on rules (security) stay in `AGENTS.md`.
- **Omit silently — don't narrate the omission.** When something lives in `AGENTS.md` or another guide, leave it out; never add "X is in AGENTS.md, won't re-explain". Cross-reference only to send the reader somewhere to _act_ ("see staging-guide to fix the shot's staging"), never to justify a cut.
- **Link a sibling skill once per file, where the agent acts on it** — the `## Routing` list (or the skill's designated routing bullet) is the router; a later step that needs the same destination just states its rule. Cut the three that earn nothing: the attribution (`(per staging-guide)` on a rule already stated in place), the re-route from a `references/` doc back to what its parent SKILL routes, and the back-link to the caller ("this feeds drafting-guide"). A `## Don't` / preflight-bail / Done-step pointer is a guardrail, not a duplicate — keep it.

## Check before you ship

- **Budget** — `bun run skills:check`: each `SKILL.md` ≤ 3000, each `references/*.md` ≤ 1500. Over budget = inlined detail to route into `references/` (progressive disclosure), don't pad.
- **Journey budget** — the same command runs `scripts/check-journeys.ts`, which defines each journey's files and budget. Renaming or splitting a journey file means updating its entry; a new shipped subagent with no journey fails the check.
- **Quality** — run `konte-skill-quality-review` to score clarity, completeness, trigger precision, scope, anti-patterns, and density; bring it into line before shipping.
