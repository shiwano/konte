---
name: agents-md-guide
description: Conventions for this repo's root AGENTS.md — what earns a line there, and how to verify it. Read before adding to, trimming, or restructuring it.
user-invocable: false
---

Conventions for writing and editing the repo's own root `AGENTS.md` (the workspace one konte ships is `template-skills-guide`'s). It loads into context on **every** turn, so a line earns its place only if it changes what the agent does and isn't trivially readable from the code — **when in doubt, cut.**

## Keep vs drop

Keep **shared decision rules, contracts, and editing requirements**:

- design principles that guide changes across subsystems
- non-obvious editing requirements — required companion edits and conventions
- formats — address `<stage>:…`, asset paths, `__konte:…__` placeholders, id prefixes (`v-…`)
- CLI commands and public DSL API (`defineVideo`, `adapters.*`, `define*Asset`)
- on-disk layout (`konte.state.json`, `.konte/…`, `review/…/handoffs/`)
- behavioral rules — a stale deterministic accept re-bakes; secrets never persisted

Drop **implementation detail** — what the agent can read from the code when it needs it:

- source paths and symbol names that only explain the implementation
- error codes — say a command fails; the code itself is grep-able (`KonteErrorCode`)
- "how it works" mechanics (which function computes what, `fs.watch`, libx264, …)
- meta-commentary on the doc's own structure — why a section exists or sits where it does

**The test** — does the concrete path or symbol identify where to edit or which contract to preserve? Keep it when it prevents an editing mistake; omit it when it only describes the implementation.

Cut in one direction, but edit in both: an editing pass also adds the genuinely-missing concept.

## Concept over enumeration

- **State the concept, not an exhaustive list** — exhaustive lists rot and bloat; give a few representative items, end with `…`.
- **Never enumerate every command, file, or error code** — that's what `--help` and the code are for.

## Prose vs bullets

- **Bullet list only for a genuine parallel enumeration** — a set of terms, the asset kinds, a short conventions checklist.
- **A single fact or multi-sentence explanation is prose** — split a long paragraph at its logical seams.
- **One theme per `###` heading** — if naming one needs "&", split it.
- **Not the skills' terse-first rule** (`template-skills-guide`) — AGENTS.md keeps conceptual prose. Only the token discipline is shared: cut narration, recap and hedging.

- **Use a structure diagram only when needed** — limit it to editing targets and important boundaries.

## Verify before you write

- **Check every fact against the code before adding/changing it** — exact command/symbol/path and actual behavior; a wrong fact loads every turn and misleads on every task.
- **Fix stale references you pass on the way** — names get renamed, dirs move, rosters and fields get added.

## AGENTS.md vs skills

- **Keep shared decision rules, terminology, and editing conventions in AGENTS.md** — task-specific detail goes in a skill with a one-line pointer. A stable public API does not need exhaustive coverage here.
- **Always-on rules (e.g. security) stay in AGENTS.md.**
- **Omit silently — don't narrate the omission.** Point to the skill so the reader can act ("see the `template-skills-guide` skill"), never to justify a cut ("detail is in the code, so omitted").

## Check the cost

`bun run skills:check` charges the root `AGENTS.md` to every `dev-*` journey in `scripts/check-journeys.ts`. When one goes over budget, inspect its per-file counts and cut duplication or task-irrelevant detail across that journey.
