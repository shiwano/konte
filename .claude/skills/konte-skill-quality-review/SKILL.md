---
name: konte-skill-quality-review
description: Review and improve konte's template or dev skills against its conventions. Use when auditing, reviewing, or improving skill quality; fix findings and verify unless the user requests review only.
user-invocable: true
---

Improvement is **done** when in-scope skills meet **konte's** conventions (`template-skills-guide`, `agents-md-guide`), actionable findings are fixed, and verification passes; report any unresolved findings or check failures as incomplete. An explicit review-only request ends with findings and proposed fixes.

## 0. First rule — cut, don't pad

- **The highest-value fix is almost always deletion** — when in doubt, cut; a correct-but-bloated skill still fails.
- **Cut anything redundant, over-explained, or stated elsewhere** (a sibling skill, a `*-guide`, `AGENTS.md`) — point to the source in one line, never restate it. A rule restated across siblings is a one-owner violation: pick the owner, route the rest.

## 1. Scope — pick the set

- **Template skills** (shipped, highest stakes) — `src/cli/templates/workspace/dot.agents/skills/*/SKILL.md` and their `references/*.md`.
- **Repo dev skills** — `.claude/skills/*/SKILL.md` and their `references/*.md`.
- **Default to template skills**; narrow to a named skill or one root on request. Ignore `dot.claude/skills/` twins — generated mirrors.

## 2. Gather inputs first

- **Get token counts, don't eyeball** — run `bun run skills:check`; use the per-file numbers **and** the journey-chain total it prints (chain-level creep hides behind passing per-file numbers).
- **Read each `SKILL.md` in full plus any `references/` it routes to** — for a routing/guide skill, skim what it points at so completeness/scope are judged against reality.

## 3. Score each skill 1–5 per dimension

1. **clarity** — opening fixes scope and definition of done; steps ordered; smallest snippet shown not narrated; load-bearing rule **bold**. Penalize ambiguity, "what" over "why".
2. **completeness** — classify by content as procedure or reference; apply `template-skills-guide`'s Body criteria only where relevant. Penalize a gap that strands the agent.
3. **trigger precision** — the `description` is the **whole routing signal**: fires exactly when it should, doesn't over-fire, concrete phrases ("Use when…" / "Read when…"). Penalize vague/overlapping descriptions that mis-route against siblings.
4. **scope coverage** — single-purpose; cross-references siblings **by name**, not duplicating. Penalize a skill doing a sibling's job, or knowledge that belongs in `AGENTS.md` / a `*-guide`.
5. **anti-patterns** — bloat, restating names/types, duplicating `AGENTS.md`, dead cross-refs, meta-commentary on the doc's own organization or addressing the maintainer/human instead of the working agent, drift from the real DSL/CLI, secrets or resolved `${VAR}` in examples. Penalize each.
6. **density** — terse-first: one rule per line, why inline (`**rule** — why`). Penalize prose paragraphs where bullets fit, narration / recap / hedging / "this is deliberate" asides, and an if-X-then-Y fork as sentences instead of a `state → destination` bullet list. Exempt: the opening scope/done sentence and a `## Prompt Shape` template line stay prose.

## 4. konte guardrails — do NOT flag these

- **`user-invocable` is correct** — konte / Claude Code convention, not an "unknown field".
- **No `USE FOR:` / `DO NOT USE FOR:` sections required** — konte routes via the `description`.
- **Token budget** (`.waza.yaml`): `SKILL.md` ≤ 3000, `references/*.md` ≤ 1500, `templates/agents/*.md` ≤ 3000. Under budget never excuses skipping §0; over budget = route inlined detail into `references/`, don't inflate.
- **Naming**: **template** skills are user-invocable → `konte-<name>`, agent-only → `<topic>-guide`. Repo dev skills follow the same intent loosely — `arch-*-guide` for subsystem references, a descriptive `<topic>-authoring` / `run-<thing>` elsewhere. Flag a dev-skill name only when it misroutes against a sibling, not for the suffix.

## 5. Fix and verify

- **Apply the smallest fix for each finding** — verify factual corrections against the source or implementation; edit within the requested scope. Skip edits for review-only requests.
- **Confirm unresolved requirements or specification changes** before dependent edits; continue independent fixes.
- **Re-read changed skills and routed references** — reassess §3 and fix remaining actionable findings. Use `konte-prose-trim` on changed prose.
- **Run `bun run skills:check` after edits** — compare per-file and journey totals; fix regressions and verify changed paths, commands, and examples against their sources.

## 6. Report

- **Lead with the changes and verification results**; for review-only requests, lead with findings and smallest fixes.
- **One row per skill** — `name | tokens | clarity / completeness / trigger / scope / anti-patterns / density | overall`; report final scores after edits.
- **List unresolved findings and failed checks** with the blocker or next action. For every score ≤ 3, cite the issue and the convention it breaks.

## Don't

- Don't grade by the agentskills.io spec — konte's conventions (§4) win.
- Don't stop at scoring or proposed fixes unless the user requested review only or the remaining work requires clarification.
- Don't run waza `quality`.
