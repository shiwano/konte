---
name: arch-cli-guide
description: Read when adding or changing a CLI command — its scope and root resolution, the startup sequence, the output conventions an agent acts on (Next steps, confirmation, selection, lists, help text), the settings files and timestamps.
user-invocable: false
---

Write every CLI output for an agent to act on, not for a human to read.

## Which root

- `konte.config.json` / `konte.credentials.json` / `konte.version` / `adapters/` / `tsconfig.json` / `node_modules/` / `.konte/{mod.ts,template.lock.json,tools,transpiler-cache,current-video}` → `workspaceRoot`.
- `konte.state.json` / a definition file / `assets/` / `dist/` / `review/` / `patches/` / `.konte/{jobs.db,logs,cache,frame-src}` → `videoRoot`.
- Only backend resolution and the ComfyUI backend take both (`VideoRoots`); the other backends take a bare `videoRoot`.
- Video selection has no "auto-select the only video" rule; with neither a cwd video nor a current video, the command fails.
- `konte video current` is the session opener: the current video, its logline, runtime, last review scope and last completed export. It is the one video command that never fails (no videos / none selected / current gone are states, not errors), and it omits the shot list, feedback and Next steps.
- `workspace new` creates in cwd; `workspace setup` resolves the enclosing workspace and repairs it without loading credentials or type-checking. Both generate agent settings before runtime prefetch.

## Scope and startup

- Commands declare their scope: `none` (`workspace new`, `workspace setup`, `lsp`), `workspace` (`video *`, `adapter *`, `settings`, `mcp serve`), or `video` — the default, so a new command opts out explicitly.
- The entry re-execs once to move Bun's transpiler cache into the workspace. The child resolves the roots, loads the workspace credentials into the environment, sets the tool-cache root, then runs the template sync and type-check.
- The type-check covers the whole workspace, but only the current video's, the adapters' and the workspace's own diagnostics are fatal — a broken sibling video is reported and stepped over.
- `generate` / `preview` / `export` are top-level commands; there is no `animatic` or `video` command group. `status` is always whole-project; a filter command like `clean` takes an `[address-scope]` to narrow to one stage.

## Output conventions

- Next steps — `status` turns computed staleness/review/problem state and any standing comment into ready-to-run commands, printed as a `Next steps:` block. The sections are `-v` only: every state in them has a step here.
- Confirmation — a destructive or stale-propagating action (e.g. `clean`) prompts first and takes `-y, --yes` / `--no`. With no TTY on stdin and neither flag, fail instead of hanging.
- Selection — a command offering a choice (e.g. `video new`'s template) takes a flag to supply it (`--template`); with no TTY and no flag it fails.
- List commands (e.g. `job list`) — newest-first, 50 rows by default, `--limit <n>` / `--all`.
- Help text — `.description()` is one concise line, no trailing period; detail goes in `.addHelpText("after", …)`: a short prose paragraph of what the command does and its argument/scope semantics, then an aligned `Examples:` block (command left, what it does right). See `prune` / `status`.

## Media inspection (`konte probe`)

- `audio` / `contact-sheet` / `motion` / `thumbnails` — on one or more, in any mix, of a `<variantId>`, an address, or an `<address-scope>` sweeping every matching variant it can read. `motion` also takes a `<stage>:shot.<id>#composition`, drawn live from the definition and never swept.
- `crop` — one still, rendering `--rect` windows as `imageCrop` would (an `imageCrop` asset's own window and master derived).
- `reel-audio` — an `<animatic|video[:shot.<id>]>` scope.
- `reel-thumbnails` — one `<stage>:shot.<id>`; a whole stage is `contact-sheet`'s.
- `jsx` — renders a `jsxImage` from its definition, writing nothing.
- `export` — an optional `[outputFile]` (default: the last real export), reporting the MP4's real resolution/duration/fps/audio.

## Settings

- An environment is two workspace files: `konte.config.json` (non-secret) and `konte.credentials.json` (API keys, gitignored). A credentials file the CLI cannot read is an error.
- The key set is open — a custom adapter may name any variable — over the keys konte ships with a label and a source.
- `konte settings` edits both in the browser: one page, a tab per file, each saving on its own. The credentials tab reports whether a key is set, never its value.

## Timestamps

Always UTC, in two non-interchangeable forms: ISO 8601 for data fields (any `createdAt`), and compact sortable `YYYYMMDDTHHmmssSSS` for filenames (agent notes, review files, render/export outputs). A review file's id is the compact form of its `createdAt`.
