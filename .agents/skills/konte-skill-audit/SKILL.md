---
name: konte-skill-audit
description: Audit and fix every skill at once — cut tokens, correct drift from the source, narrow overlapping triggers and scope, across parallel subagents, with journeys compared before and after. Use when asked to audit, review, trim or cut tokens from all skills, a whole root of them, one skill, or an AGENTS.md.
user-invocable: true
argument-hint: "[skill root | skill name | AGENTS.md]"
---

Done = every in-scope file trimmed with no fact, rule, why or judgment lost, the drift the pass found verified and fixed or reported, and `bun run check` passing; nothing committed unless asked.

## Scope

- Default: template skills (`src/cli/templates/workspace/dot.agents/skills/`), dev skills (`.agents/skills/`), plugin skills (`plugin/plugins/konte/skills/`), the root `AGENTS.md` and the shipped `src/cli/templates/workspace/AGENTS.md`. `$ARGUMENTS` narrows to one root, skill or `AGENTS.md`.
- Subagent contracts (`src/cli/templates/agents/`) only when asked.
- Adapter guides (`src/cli/templates/workspace/dot.konte/guides/`) only when asked — the brief adds `prompt-guide-authoring`'s "Auditing an existing guide" against each guide's adapters; a shared guide shares a group with the guides its adapters list after it.
- Never `dot.claude/skills/` — generated twins.

## 1. Measure

- `bun run skills:check > <scratchpad>/before.txt` — the per-file and journey totals the report compares against.

## 2. Split

- Groups of ~35–45 KB, `fd -t f -e md <root> | xargs wc -c | sort -n` to size them.
- Files that restate each other share a group — a SKILL with its `references/`, the convention skills (`template-skills-guide`, `konte-prose-trim`, `agents-md-guide`) with both `AGENTS.md` — so one agent picks each rule's owner.
- Every file in exactly one group — two agents on one file overwrite each other.

## 3. Brief

Write one brief to the scratchpad; every subagent reads it:

- Read `konte-prose-trim` and `template-skills-guide` in full; apply them to the whole of each assigned file. The root `AGENTS.md` follows `agents-md-guide` instead — no one-rule-per-line or tables-to-bullets there.
- An `AGENTS.md` is the owner a skill routes to — never delete a fact from it because a skill also states it; report the pair.
- Priority: restatement within a file, of a sibling, of the matching `AGENTS.md` (root for dev, `src/cli/templates/workspace/AGENTS.md` for template) → route to the owner or delete, after `rg` confirms the owner says it; a `description` whose trigger overlaps a sibling's, or a body doing a sibling's job → narrow it; prose paragraphs → one rule per line; foils, provenance, meta, recap; tables → bullets; stray bold.
- Keep every command, flag, identifier, path, number and snippet still needed — `rg` it in `src/` before deleting anything that looks like a fact; add no new facts; keep `name:` and the `description` trigger phrases.
- `rg` every command, flag, finding code and output line a skill names; fix drift only when the fix is mechanical and certain.
- Edit only assigned files; run no `check`; commit nothing.
- Report per file: what was cut, what was kept on purpose and why, drift fixed and drift left, each with its source location.

## 4. Fan out

- One general-purpose subagent per group, all spawned in one message, each prompt naming the brief and its files plus the siblings to compare against.

## 5. Verify

- Check each reported drift against the source before acting — a "stale" label can be real output (`rg` the command's printer).
- Fix true drift the agents left as reported; route a fix that needs a judgment to the human.
- `bun run check`; then `bun run skills:check > <scratchpad>/after.txt` and pair the journey lines of both files.

## 6. Report

- Total tokens and each journey, before → after.
- The kinds of cuts, the drift fixed, the drift left open.
- Offer to lower journey budgets to the new totals — a cut is logged in `scripts/check-journeys.ts`'s budget log.
