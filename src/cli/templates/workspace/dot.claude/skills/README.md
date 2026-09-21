# This directory is for Claude-only skill sources

Skills are authored in `dot.agents/skills/` (the single source of truth) and
mirrored to `.claude/skills/` twins at build time (`scripts/embed-templates.ts`).
Don't add skills here — add them under `dot.agents/skills/`.

The exception is `konte-lsp`: a Claude-only plugin
(`.claude-plugin/plugin.json`, no `SKILL.md`) that has no cross-agent twin, so it
is authored directly here.

- A hand-written `SKILL.md` under this directory makes the embed fail (a guard
  that keeps agents the single source).
- This README is not shipped to user projects (ignored by embed).
