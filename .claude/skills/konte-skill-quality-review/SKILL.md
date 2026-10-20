---
name: konte-skill-quality-review
description: Review and improve konte's template or dev skills against its conventions. Use when auditing, reviewing, or improving skill quality; fix findings and verify unless the user requests review only.
user-invocable: true
---

Improvement is done when in-scope skills meet konte's conventions (`template-skills-guide`, `agents-md-guide`), actionable findings are fixed, and verification passes; report any unresolved findings or check failures as incomplete. An explicit review-only request ends with findings and proposed fixes.

## 0. First rule — cut, don't pad

- The highest-value fix is almost always deletion — when in doubt, cut; a correct-but-bloated skill still fails.
- Cut anything redundant, over-explained, or stated elsewhere (a sibling skill, a `*-guide`, `AGENTS.md`) — a rule restated across siblings is a one-owner violation: pick the owner, route the rest in one line.

## 1. Scope — pick the set

- Template skills (shipped, highest stakes) — `src/cli/templates/workspace/dot.agents/skills/*/SKILL.md` and their `references/*.md`.
- Repo dev skills — `.claude/skills/*/SKILL.md` and their `references/*.md`.
- Default to template skills; narrow to a named skill or one root on request. Ignore `dot.claude/skills/` twins — generated mirrors.

## 2. Gather inputs first

- Run `bun run skills:check` for token counts, don't eyeball — use the per-file numbers and the journey-chain total (chain-level creep hides behind passing per-file numbers).
- Read each `SKILL.md` in full plus any `references/` it routes to — for a routing skill, skim what it points at to judge completeness/scope against reality.

## 3. Score each skill 1–5 per dimension

The criteria are `template-skills-guide`'s.

1. clarity — opening fixes scope and done; steps ordered; snippet shown not narrated; bold only on the one or two most-breakable rules. Penalize ambiguity, "what" over "why".
2. completeness — classify as procedure or reference; apply the Body criteria where relevant. Penalize a gap that strands the agent.
3. trigger precision — the `description` fires exactly when it should, with concrete phrases ("Use when…" / "Read when…"). Penalize vague/overlapping descriptions that mis-route against siblings.
4. scope coverage — single-purpose; routes to siblings by name. Penalize a skill doing a sibling's job, or knowledge that belongs in `AGENTS.md` / a `*-guide`.
5. anti-patterns — anything on `konte-prose-trim`'s Cut list, dead cross-refs, addressing the maintainer/human instead of the working agent, drift from the real DSL/CLI, secrets or resolved `${VAR}` in examples. Penalize each.
6. density — terse-first voice. Penalize prose paragraphs where bullets fit, and an if-X-then-Y fork as sentences instead of a `state → destination` list. Exempt: the opening scope/done sentence and a `## Prompt Shape` template line.

## 4. konte guardrails — do NOT flag these

- `user-invocable` is correct — konte / Claude Code convention, not an "unknown field".
- No `USE FOR:` / `DO NOT USE FOR:` sections required — konte routes via the `description`.
- Token budget — under budget never excuses skipping §0.
- Naming — dev skills follow the template convention loosely — `arch-*-guide` for subsystem references, a descriptive `<topic>-authoring` / `run-<thing>` elsewhere; flag one only when it misroutes against a sibling.

## 5. Fix and verify

- Apply the smallest fix for each finding within the requested scope — verify factual corrections against the source. Skip edits for review-only requests.
- Confirm unresolved requirements or specification changes before dependent edits; continue independent fixes.
- Re-read changed skills and routed references — reassess §3 and fix remaining findings. Run `konte-prose-trim` on changed prose.
- Run `bun run skills:check` after edits — compare per-file and journey totals and fix regressions; verify changed paths, commands, and examples against their sources.

## 6. Report

- Lead with the changes and verification results; for review-only requests, lead with findings and smallest fixes.
- One row per skill — `name | tokens | clarity / completeness / trigger / scope / anti-patterns / density | overall`; report final scores after edits.
- List unresolved findings and failed checks with the blocker or next action. For every score ≤ 3, cite the issue and the convention it breaks.

## Don't

- Don't grade by the agentskills.io spec — konte's conventions (§4) win.
- Don't stop at scoring or proposed fixes unless the user requested review only or the remaining work requires clarification.
- Don't run waza `quality`.
