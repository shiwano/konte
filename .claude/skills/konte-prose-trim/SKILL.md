---
name: konte-prose-trim
description: Cut redundant and meta prose from what a change just touched — skills, guides, docs, AGENTS.md, code comments. Use after writing or editing any of them, or on /konte-prose-trim.
user-invocable: true
argument-hint: "[path | git-ref]"
---

Delete the explanation an agent adds by reflex. Done = every changed `.md` line and every changed comment carries only facts the reader acts on, and `bun run check` passes. Scoring a whole skill across six dimensions is `konte-skill-quality-review`'s; this one only deletes, and covers any doc or comment.

## Scope

- **Default: the working diff** — `git diff HEAD` plus untracked files. `$ARGUMENTS` overrides with a path, or a ref to diff against (`main`, `HEAD~3`).
- **In scope**: `*.md` (skills, `references/`, `src/core/dsl/adapters/guides/`, `dot.konte/guides/`, `AGENTS.md`, `docs/`) and comments in changed `*.ts` / `*.tsx`.
- **Only lines the diff touched** — untouched prose is out of scope unless `$ARGUMENTS` names the file.
- **Never edit `dot.claude/skills/`** — generated twins; fix the `dot.agents/` source.

## Cut

Each is a deletion, not a rewrite — the surrounding sentence almost always already says the thing.

- **Contrastive definitions** — "a bad draw, **not** a bad prompt", "it reads as an X and is not one". Keep the assertion, drop the foil.
- **Rationale clauses** — "so that…", "which means…", "because…" hung off a rule that stands without them.
- **Evidence and provenance** — measurements, benchmarks, "we found", "testing showed", how the conclusion was reached. The conclusion ships; the investigation does not.
- **Mechanism** the reader cannot act on. Keep it only where it changes what they do.
- **Restatement** of a sibling skill, `AGENTS.md`, a type, a schema, or the code under the comment. Route to the owner in one line.
- **Meta-commentary on the document** — "this section covers", "as mentioned above", "note that", "it's worth mentioning".
- **Self-justification** — "this is deliberate", "not an oversight", "for clarity".
- **Editorializing** — "simply", "just", "powerful", "elegant", "of course".
- **Recap** — "In summary", a closing paragraph that repeats the bullets above it.
- **A comment restating its code** — the default is no comment; keep one only where intent cannot be recovered from the code.

## Keep

- A fact that changes what the reader does.
- A non-obvious constraint, failure mode, or footgun ("from 1.1 up the model drops phonemes").
- A rule's inline why in the house form — `**rule** — why`, one line.
- A skill's opening scope/done sentence.
- Anything the user asked for explicitly.

## Procedure

1. List the changed files in scope.
2. Read each file in full, then judge **only the changed lines** against Cut.
3. Apply deletions with Edit. Fold the remainder into the surrounding line; never leave a stub.
4. Re-read each edited passage cold. If a cut took a fact with it, restore that fact alone.
5. `bun run check`.
6. Report one line per file: what was cut.

## Don't

- Don't rewrite for style, reorder, or reword — this skill only deletes.
- Don't touch prose the change did not introduce unless `$ARGUMENTS` says so.
- Don't cut a section for being long. Redundancy is the signal, length is not.
