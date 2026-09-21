# AGENTS.md

## Design Policy

**No backward compatibility yet.** konte is still pre-release and has no users. Do NOT preserve backward compatibility, add migration paths, or keep deprecated APIs. Always pursue the best possible design, even if it means breaking changes.

**The human directs; the agent produces.** The human's one job is taste — watching the cut and deciding what changes. Review work that is not a taste decision (re-accepting a shot whose picture did not change, restating a decision an accept already recorded) is a defect. The CLI is the agent's surface and the review UI is the human's; both get the same design density.

**An agent obeys an exit code and reads what is on its path.** It reads the output of the command it just ran and the `Next steps` line, and skips everything optional — a warning channel, a flag it would have to think to pass, a guide it is asked to judge it needs. Put a consequence in the output of the command that causes it; a stop is a refusal.

**Before a finding becomes a gate, ask three questions in order.** Can konte derive it — its own rule already settles the answer, so it fills the slot? Can the type system refuse it — a "forgot" is a compile error? Can the human's accept waive it — a judgment shown on the page they accept is signed off by that accept? Only what survives all three is a gate, and a gate is precise or it is a tax.

**Direction stays above the model.** A new model is an adapter file and its craft guide. The model layer has to stay cheap to add and cheap to read.

## Security

**Never persist resolved secrets.** Values from expanding `${VAR}` placeholders (auth tokens, API keys, credentialed URLs) must not be written to any on-disk artifact (state, job files, logs). Store the unresolved placeholder and resolve it at use time; redact secrets in logs.

## Common Commands

```sh
bun run konte    # Run CLI in development
bun run test:run # Run all tests
bun run test:run -- src/core/**/*.test.ts  # Run a single test
bun run check    # lint + format check
bun run build    # Build binary
```

## Non-obvious Conventions

- **Zod schemas** define types in `src/core/types/`
- **Imports** use `.js` extension for relative paths
- **DSL exports** — when adding a new DSL function or type, export it from **both** `src/core/dsl/index.ts` (runtime) and `src/core/dsl/template-entry.ts` (type generation for user projects' `.konte/mod.ts`)
- **Errors** surface as a typed code (`KonteErrorCode`), never a bare string — the codes are the contract, their messages are not

## Architecture Notes

### Workspace and videos

A konte project is a **workspace** (`konte.config.json`, `konte.credentials.json`, `adapters/`, `tsconfig.json`, `.konte/{mod.ts,template.lock.json,tools,current-video}`) holding N **videos** under `videos/<name>/` (`konte.state.json`, `direction.ts` and the stage files, `assets/`, `dist/`, `review/`, `patches/`, `.konte/{jobs.db,logs,cache}`).

A command acts on the video cwd sits inside, else the workspace's **current video** (`.konte/current-video`, set by `konte video new` / `video use`); there is no `--video` flag — use `--cwd`. A credential is keyed by the environment variable it becomes and loaded at startup; a real env var wins.

### Terminology

- **address**: `<stage>:shot.<shotId>.<name>` / `<stage>:timeline.<name>` / `reference:<id>` / `animatic:plate.<setupId>` — one string is the state key, the graph node, and the body of a DSL placeholder (`__konte:animatic:shot.01.first__`).
- **target**: the entity at an address — `variants` and/or `feedback`. A feedback-only target (`video:shot.01`, `direction:<field path>`) holds comments only.
- **address-scope**: a prefix filtering many addresses — a stage, a shot, `animatic:plate`, one asset (`inspect`, `clean`, `prune`, `probe`). **stage-scope**: exactly one `<stage>` (`generate`, `preview`, `export`). Bare forms only.
- **`#`**: the reserved namespace, not a legal identifier character. A **reserved name** fills the name slot (`video:shot.01#composition`, `animatic:shot.01#stem`, `video:timeline#stem`); the **delivery derivative** `#delivery` appends to any address and is always last.
- **variant**: one take at an address, id `v-…`, globally unique; a generation job shares its variant's id (`.konte/jobs.db`, `.konte/logs/<id>.log`). `accept` takes a `<variantId>`, except a materialized leaf (composition, stem), accepted by address.
- **beat**: a lens role, spanning the N shots that name it by `role`.

### Stages

`direction` (`direction.ts`, `defineDirection`) is the ordered shots, the piece-wide policy and the rosters (`characters`, `props`, `locations`, `setups`); every other stage builds on it, and it is addressable only as feedback-only targets. `reference` (`reference.tsx`, `defineReference`) holds shared assets, generated once and consumed by both creative stages. `animatic` (`animatic.tsx`, `defineAnimatic`) is the board on the direction's clock; `video` (`video.tsx`, `defineVideo`) the final motion picture, built on the one animatic. Each is a standalone entry file the CLI loads directly.

`defineAnimatic(direction, …)` / `defineVideo(direction, …)` derive `size`/`fps` from the direction — the working canvas is never authored (`policy.format.size` is `{ megapixels, delivery }`). Both take `timeline(({ format, shot, graphicShot, pendingShot, asideShot }) => ({ shots, soundtracks? }))`; a shot is `shot(id, (ctx) => <Composition>…)` and `.nextShot(…)` walks the direction, with `graphicShot` / `asideShot` per kind and `pendingShot` for an undeveloped one. An animatic shot's keyframes are `<Panel>` and its lines `<Audio>`; a video shot's picture is `<Video>`, reaching the board through `animatic.shot("01").image("first")` / `.stem`. A shot's goal is stated once, on the direction (`action`); a `<Panel>` adds `blocking` / `camera`, prose written from the take and hashed on its own review axis.

The direction's vocabulary, each a declaration konte never derives (see `arch-direction-guide`): a shot names a **setup** — one camera position, with `location`, `framing`, `holds` (the landmarks in frame) and `within` (the wider frame it is a window of); its **`lineup`** / **`lineupTo`** name who the frame holds, left to right; **`join`** states the boundary into it (cut, `jump-back`, `jump-forward`, `continuous`); a **`cutin`** is a second camera frame over the shot; `promptDepiction` is the noun a prompt calls a character or landmark by. A setup is realized by a **plate** (`animatic:plate.<setupId>`, from `defineAnimatic`'s `plates` callback), not a `reference:<id>`. A shot is narrative (default), `kind: "graphic"` (no camera), or `kind: "aside"` (on the clock, outside the arc; the animatic never boards one).

Two gates precede any animatic/video spend: a machine check over the direction (findings, waivable by key in each stage's `waivers`) and a per-part human acceptance (`konte preview direction` / `konte accept direction[:<part>]`). A spend also aborts on an upstream it consumes with no accepted variant, and on a negation the **prompt check** finds in a `"prompt"` / `"negativePrompt"` input — `inspect <address-scope> --prompts` lists that text; an adapter's `promptExemptions` cut out the negations its model is written with.

### Backends and adapters

Each asset kind is generated by a backend auto-selected by kind: `comfy` → local ComfyUI, `fal` → fal.ai, `local` → local media ops (`imageResize`, `videoTrim`, `jsxImage`, …); `file` is a local media reference with no generation, auto-registered as a variant. **Configuring a vendor backend is what authorizes spend on it** — comfy by `comfyui.url`, fal by its credential; never a connectivity probe. An asset on an unconfigured backend aborts `generate` before any spend.

The `adapters.*` namespace holds only the backend-less built-ins. Every **model** adapter is a workspace file under `adapters/`, authored with `defineComfyAsset` / `defineFalAsset` with a craft guide under `.konte/guides/`; `konte adapter list` / `adapter show <adapter>` are how an agent picks one without reading adapter files.

### State and staleness

All of a video's state is one `konte.state.json`, written atomically. Accepts are per asset, except the direction's, keyed by part.

A variant is **input-stale** when an input it consumed no longer matches what that address resolves to now, and **definition-stale** when its own definition changed; staleness is computed on demand and propagates downstream, across stages. The **resolved** variant for an address is the accepted one, else the newest non-stale variant with a file; a read surface (`preview`, `ref`, `probe`, `accept`) falls one further back to the newest stale take, no spend does. `generate` regenerates a stale unaccepted one and a stale deterministic one whatever its accept says, and skips a stale accepted one, so strict resolution refuses a stale accept a re-bake would replace. A human accept whose inputs alone moved **stands** (`keptInputs` on accept); only `reroll` replaces a definition-stale one, dropping a human accept only at an address it names. Both axes count: an older take whose definition still matches outranks a newer one whose has moved. A take is undecided, accepted, or **dismissed** — decided against by an accept beside it or by `konte dismiss` — and a dismissed one never resolves and is never review work.

### Generation

`konte generate <stage-scope>` is always async: it registers every dependency level at once, jobs with no dependencies run, dependents pend until their inputs are ready. Inputs reference other assets by address; the graph spans both stages, and a cycle, a missing asset, or a reference to an undeveloped `pendingShot` is an error. `konte reroll <targets>` adds variants to pick among; `konte patch new|apply|remove|list` corrects one take (`patches/<variantId>.ts`, `definePatch`). Nothing pushes a completion; `konte job wait` blocks for one.

Every take is review work, bar a `#delivery` upscale, which konte accepts on completion; a **deterministic** asset has one outcome — no `reroll` / `dismiss`. A shot **composition** and an audio **stem** are graph leaves with no job: rendered live wherever used, materialized only on accept, by address.

`konte mcp serve` is a per-workspace daemon that watches every video's jobs and cascades submission. It registers no tool, resource or prompt — every outcome is learned by blocking on the CLI.

### Templates

Templates live under `src/cli/templates/`. Upgrade overwrites managed files except `HOUSE_RULES.md`; `workspace new` / `workspace setup` render agent settings, preserving user values and replacing konte launch paths. Skills are authored under `workspace/dot.agents/skills/` (the `dot.claude/` twins are generated), subagents under `agents/<name>.md`; see `template-skills-guide`.

### Subsystem guides

Read when touching one:

- `arch-cli-guide` — command scope and root resolution, output conventions (Next steps, confirmation, selection, lists, help text), settings, timestamps
- `arch-direction-guide` — the arc checker and finding classes, setups, lineup, join, waivers, voice casting, part hashing, direction acceptance gates
- `arch-review-system-guide` — reviews, feedback, handoffs, review reachability
- `arch-jobs-guide` — standalone job kinds, run lease, keyframe normalization, the MCP daemon, comfy provisioning
- `arch-patch-guide` — variant lineage and the leaf rule, patch staleness axes, patch lifetime
- `arch-audio-guide` — muxing, `<Soundtrack>`/`<Sound>`, definition-hash exclusion
- `arch-animatic-guide` — the animatic stage: `<Panel>` and its windows, asides, the derived stem, the review surfaces
- `arch-template-system-guide` — `konte workspace new` templates (`workspace/` + `workspace/videos/<name>/`); never write scaffold files programmatically
- `arch-delivery-guide` — delivery resolution, upscale modes, `#delivery`, export job
- `arch-managed-binaries-guide` — managed ffmpeg/Chromium/tsc/cloudflared, the tool cache + overrides
- `adapter-authoring` — `define*Asset`, input types, validators, `allowedIn`, the prompt check's exemptions
