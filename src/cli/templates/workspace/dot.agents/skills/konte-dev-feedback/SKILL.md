---
name: konte-dev-feedback
description: Summarize konte's own rough edges hit while using it as developer-ready feedback to contribute back. Use when wrapping up a session to report konte's own friction back to its maintainers.
user-invocable: true
disable-model-invocation: true
---

Turn hands-on konte usage into concrete feedback for improving konte itself, with enough specifics that a maintainer can act without re-deriving the context. Report in the chat; do not write a file.

## 1. Gather the friction

Walk back through this session and collect every point where konte got in the way:

- **Missing command/flag** — one you expected but didn't exist.
- **Misleading output** — CLI output, a "Next steps" block, or terminology that misled you or needed a second read.
- **Weak error** — didn't explain cause or fix; you had to open logs, inspect state, or guess.
- **Truth mismatch** — two konte surfaces disagreed about state, progress, accepted variants, reviews, or jobs.
- **Inference gap** — a place you had to infer or gamble instead of reading a definitive answer.
- **Docs let you down** — `AGENTS.md`, a guide, or a skill that was missing, hard to find, misleading, too verbose, contradicted real behavior, or left you to work it out by trial; note what would have helped.
- **Extra steps** — a repeated workaround for what should be one action.
- **Surprising behavior** — staleness, acceptance, dependency cascade, review submission, or variant lifecycle.
- **Review result gaps** — missing variant IDs, partial decisions, feedback not attached to variants, or unclear accepted/unaccepted state.
- **Pull from what actually happened** — real commands and output; don't invent issues to pad the list.

## 2. Score severity

- **P0** — blocked progress, could cause a wrong/destructive action, or forced a hack to continue.
- **P1** — workable but clearly wrong or awkward; real friction.
- **P2** — nice-to-have polish.

## 3. Report in the chat

- **Open with a Top 3 for this session** — the highest-leverage fixes.

Then group by category:

- Bug
- Missing feature
- Confusing UX
- Weak error
- Truth mismatch
- Docs & skills
- Extra steps

For each item (separate consecutive items with a `---` line):

- **Title**
- **What I was doing** → **What happened** → **What I expected**
- **Repro**: exact `konte ...` command(s) and key output
- **Severity**
- **Suggested fix**
- **Confidence**: confirmed / needs confirmation
