---
name: arch-cli-guide
description: Read when adding or changing a CLI command — its scope and root resolution, the startup sequence, the output conventions an agent acts on (Next steps, confirmation, selection, lists, help text), the settings files and timestamps.
user-invocable: false
---

Write every CLI output for an agent to act on.

## Which root

- A workspace file (AGENTS.md's list, plus `konte.version`, `node_modules/`, `.konte/transpiler-cache`) → `workspaceRoot`.
- A video file (AGENTS.md's list, plus `.konte/frame-src`) → `videoRoot`.
- Only backend resolution and the ComfyUI backend take both (`VideoRoots`); the other backends take a bare `videoRoot`.
- With neither a cwd video nor a current video, a video-scope command fails — it never auto-selects the only video.
- `konte video current` is the session opener: the current video, its logline, runtime, last review scope and last completed export. It never fails — no videos / none selected / current gone each print as a state — and omits the shot list, feedback and Next steps.
- `workspace new` creates in cwd; `workspace setup` resolves the enclosing workspace and repairs it without loading credentials or type-checking. Both generate agent settings before runtime prefetch.

## Scope and startup

- Commands declare their scope: `none` (`workspace new`, `workspace setup`, `licenses`), `workspace` (`video *`, `adapter *`, `settings`, `mcp serve`, `mcp worker`), or `video` — the default, so a new command opts out explicitly.
- The entry re-execs once to move Bun's transpiler cache into the workspace. The child resolves the roots, loads the workspace credentials into the environment, sets the tool-cache root, then runs the managed-file check (`arch-template-system-guide`; never `mcp serve` / `mcp worker`) and type-check.
- The type-check covers the whole workspace, but only the current video's, the adapters' and the workspace's own diagnostics are fatal — a broken sibling video is reported and stepped over.
- `generate` / `preview` / `export` are top-level commands — no per-stage command group. `status` is always whole-project; a filter command like `clean` takes an `[address-scope]` to narrow to one stage.

## Output conventions

- Next steps — `status` turns computed staleness/review/problem state and any standing comment into ready-to-run commands, printed as a `Next steps:` block. The sections are `-v` only: every state in them has a step here. Each step is one line, `<command or (label)> — <detail>`: a detail holds no `—` of its own, and a command written in it is one to run — an action not to take is named in words.
- Confirmation — a destructive or stale-propagating action (e.g. `clean`) prompts first and takes `-y, --yes` / `--no`. With no TTY on stdin and neither flag, fail instead of hanging: `CONFIRMATION_REQUIRED` carries the consequence and the invocation re-run with `--yes`. `confirmAction` takes the consequence as a statement and asks the question itself.
- Selection — a command offering a choice (e.g. `video new`'s template) takes a flag to supply it (`--template`); with no TTY and no flag it fails.
- List commands (e.g. `job list`) — newest-first, 50 rows by default, `--limit <n>` / `--all`.
- Help text — `.description()` is one concise line, no trailing period; detail goes in `.addHelpText("after", …)`: a short paragraph of what the command does and its argument/scope semantics, then an aligned `Examples:` block (command left, what it does right). See `clean` / `status`.

## Media inspection (`konte probe`)

- `audio` / `contact-sheet` / `image` / `motion` / `thumbnails` — on one or more, in any mix, of a `<variantId>`, an address, or an `<address-scope>` sweeping every matching variant it can read. `motion` also takes a `<stage>:shot.<id>#composition`, drawn live from the definition and never swept.
- `crop` — one still, rendering `--rect` windows as `imageCrop` would (an `imageCrop` asset's own window and master derived).
- `reel-audio` / `reel-lines` — an `<animatic|video[:shot.<id>]>` scope.
- `reel-thumbnails` — one `<stage>:shot.<id>`; a whole stage is `contact-sheet`'s.
- `jsx` — renders a `jsxImage` from its definition, writing nothing.
- `export` — an optional `[outputFile]` (default: the last real export), reporting the MP4's real resolution/duration/fps/audio.

## Settings

- An environment is two workspace files: `konte.config.json` (non-secret) and `konte.credentials.json` (API keys, gitignored). A credentials file the CLI cannot read is an error.
- The key set is open — a custom adapter may name any variable — over the keys konte ships with a label and a source.
- `konte settings` edits both in the browser: one page, a tab per file, each saving on its own. The credentials tab reports whether a key is set, never its value.

## Timestamps

Always UTC, in two forms:

- ISO 8601 — data fields (any `createdAt`).
- Compact sortable `YYYYMMDDTHHmmssSSS` — filenames (agent notes, review files, render/export outputs). A review file's id is the compact form of its `createdAt`.
