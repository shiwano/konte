---
name: agents-md-guide
description: Conventions for this repo's root AGENTS.md — what earns a line there, and how to verify it. Read before adding to, trimming, or restructuring it.
user-invocable: false
---

Conventions for the repo's own root `AGENTS.md` (the shipped workspace one is `template-skills-guide`'s). It loads every turn, so a line earns its place only if it changes what the agent does and isn't trivially readable from the code — when in doubt, cut.

## Keep vs drop

Keep shared decision rules, terminology, contracts, and editing requirements:

- design principles that guide changes across subsystems
- non-obvious editing requirements — required companion edits and conventions
- formats — address `<stage>:…`, asset paths, `__konte:…__` placeholders, id prefixes (`v-…`)
- CLI commands and public DSL API (`defineVideo`, `adapters.*`, `define*Asset`)
- on-disk layout (`konte.state.json`, `.konte/…`, `review/…/handoffs/`)
- behavioral rules — a stale deterministic accept re-bakes; secrets never persisted

Drop implementation detail — what the agent can read from the code when it needs it:

- source paths and symbol names that only explain the implementation
- error codes — say a command fails; the code itself is grep-able (`KonteErrorCode`)
- "how it works" mechanics (which function computes what, `fs.watch`, libx264, …)

The test — does the concrete path or symbol identify where to edit or which contract to preserve? Keep it when it prevents an editing mistake.

Cut in one direction, but edit in both: an editing pass also adds the genuinely-missing concept.

## Concept over enumeration

- State the concept with a few representative items ending in `…` — exhaustive lists rot and bloat; never enumerate every command, file, or error code (`--help` and the code do).

## Prose vs bullets

- Bullet list only for a genuine parallel enumeration — a set of terms, the asset kinds, a short conventions checklist.
- A single fact or multi-sentence explanation is prose — split a long paragraph at its logical seams.
- One theme per `###` heading — if naming one needs "&", split it.
- The skills' terse-first voice does not apply — AGENTS.md keeps conceptual prose; `konte-prose-trim`'s Cut list does.
- Use a structure diagram only when needed — limit it to editing targets and important boundaries.

## Verify before you write

- Check every fact against the code before adding/changing it — exact command/symbol/path and actual behavior; a wrong fact misleads on every task.
- Fix stale references you pass on the way — names get renamed, dirs move, rosters and fields get added.

## AGENTS.md vs skills

- Task-specific detail goes in a skill behind a one-line pointer; always-on rules (e.g. security) stay in AGENTS.md.
- Omit silently, as in the skills — never justify a cut ("detail is in the code, so omitted").

## Check the cost

`bun run skills:check` charges the root `AGENTS.md` to every `dev-*` journey in `scripts/check-journeys.ts`. When one goes over budget, inspect its per-file counts and cut duplication or task-irrelevant detail across that journey.
