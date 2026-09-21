---
name: arch-template-system-guide
description: Read when touching `konte workspace new` scaffolding or the embed step — the workspace/videos template tree, the dot. naming convention, managed and generated files. For the skills shipped inside, read template-skills-guide instead.
user-invocable: false
---

How the files `konte workspace new` writes are authored and assembled. Do not write scaffold files programmatically — always use the template system.

## The tree mirrors what it produces

```
src/cli/templates/workspace/       ← konte workspace new
  adapters/  dot.konte/mod.ts  tsconfig.json  dot.agents/  …
  videos/
    blank/  kitchen-sink/          ← konte video new <name> --template <one of these>
```

The dev tree has the same shape as a real workspace, so a video template's `import … from "konte/workspace/adapters/comfy/x.js"` — the `konte/workspace/` alias resolves to the workspace root — points at the same on-disk file here too. `embed-templates.ts` walks `workspace/` once and partitions on the key — anything under `videos/<name>/` is that video's template, everything else is the workspace scaffold.

`konte video new --template <name>` selects one; omitting it prompts.

## Naming convention

A `dot.` prefix is converted to `.` (e.g. `dot.konte/mod.ts` → `.konte/mod.ts`). The dev tree keeps `dot.konte` as-is so a real `.konte/` never collides with the repo's own gitignore.

## Generated files

`workspace/dot.konte/mod.ts` (the user-project DSL type declarations) is auto-generated — run `bun run build:generate-template-mod` after changing DSL types/builders. The embedded template assets are regenerated as part of `bun run build`.

## Where to add a file

- Shared by every video (agent setup, adapters, config) → `workspace/`.
- One video template's content → `workspace/videos/<name>/`.
- A whole new video template → a new directory under `workspace/videos/`.
- A dev-only video template → also in `DEV_VIDEO_TEMPLATES`. `kitchen-sink` is the DSL surface `check:templates` covers; grow it with the DSL.
- A dev-only skill → also in `DEV_SKILLS`.

Managed files are always-overwrite except `HOUSE_RULES.md`. Agent settings remain template-authored, but `workspace new` / `workspace setup` render their environment-specific paths outside template sync. User values are preserved; missing defaults are filled. The konte MCP/LSP launch fields and the `.konte/bin` PATH lead are regenerated — Codex through `shell_environment_policy.set.PATH`, Claude Code through a `SessionStart` hook appending an `export PATH` line to `$CLAUDE_ENV_FILE`, since its `env.PATH` never reaches the Bash tool. These settings are gitignored. Launch paths always name `.konte/bin/konte`: a compiled konte running from elsewhere (brew, a copied build) links itself there — to the `PATH` entry resolving to it, if any — except on Windows, and never over a real file `setup.sh` placed.

`konte.version` is not a template: `template-sync.ts` writes it at the workspace root on every run, ahead of the fast path. It is committed; the lock's copy of the version is not.

**A managed file (`MANAGED_TEMPLATES`) must be a workspace file.** `syncManagedTemplates` writes every managed key relative to the workspace root, so a managed key under `videos/` would land a video's file at the workspace root on the next upgrade. `embed-templates.ts` asserts this.

## Type-checking

`bun run check:templates` runs `tsc` once over `workspace/tsconfig.json`, which includes the shared adapters and every video template together — the same way a real workspace is checked.
