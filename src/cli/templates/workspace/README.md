# konte workspace

A [konte](https://github.com/shiwano/konte) workspace: AI videos you direct and a coding agent produces.

## Working in it

Open this directory in Claude Code or Codex and run the `konte-checkin` skill. The agent reports where the current video stands and proposes the next step.

After cloning or moving the workspace, run the plugin's setup skill (`/konte:setup` in Claude Code, `$konte:setup` in Codex) before the first session.

## Layout

- `videos/<name>/` — one video: its direction, stages, assets, takes, and review record.
- `adapters/` — the models this workspace generates with.
- `HOUSE_RULES.md` — standing instructions every video follows.
- `konte.config.json` — backends and settings.
