---
name: konte-run
description: Build, serve and drive konte's preview/review UI offline. Use to hand the user a live URL for their own browser, or to screenshot and click a review-UI change with headless Chrome.
user-invocable: true
argument-hint: "[show|drive] [video|animatic|reference|direction]"
---

`konte preview` serves the review UI as a React SPA. Generation needs real backends (fal/comfy), so offline we hand-craft project state + dummy media to exercise it, then optionally drive it with headless Chrome. Run everything from the repo root; the driver and fixture script live in `.claude/skills/konte-run/`.

## Routing (`$ARGUMENTS`)

The first argument picks the mode, an optional second the stage (`video` default; also `animatic` / `reference` / `direction`). With no arguments, infer from the request — default `show video`.

- `show` → serve a live preview for the **human**, hand over the URL, leave the server up. No driver.
- `drive` → **agent** path: headless Chrome screenshots / clicks via `drive.mjs`.

Both need a fixture first (step 1). Always **Build** first if `src/pages/preview/` changed.

## Prerequisites

`bun`, `google-chrome`, `ffmpeg` are already on PATH here. `bun install` if `node_modules` is absent.

## Build (REQUIRED before the UI reflects source changes)

The preview server serves the **embedded** bundle (`src/core/generated/ui-assets.ts`), **not** `src/pages/preview/dist/`. Building only `dist` shows a stale UI:

```bash
bun run build:ui:preview  # bundle SPA -> src/pages/preview/dist/
bun run build:embed-ui    # embed dist -> src/core/generated/ui-assets.ts
# (or `bun run build` for everything)
```

## Run — show the preview to the human

1. **Have something to preview.** If the user's own workspace already has generated media, run `konte preview` with `--cwd` pointing at that **video dir** (`<workspace>/videos/<name>/`). Otherwise craft a fixture (step 1 below).
2. **Serve it in the background.** `--no-auto-close` is essential — without it the server exits the moment the auto-opened browser disconnects, before the user looks.

   ```bash
   bun run konte --cwd <video-dir> preview video --no-auto-close --port 4655 &
   for i in $(seq 1 30); do curl -sf http://127.0.0.1:4655/api/state -o /dev/null && break; sleep 0.5; done
   ```

3. **Give the user the URL** (`http://localhost:4655`) and **leave the server running**. On this WSL2 box localhost-forwarding is on by default, so a Windows browser reaches the WSL-bound server directly. konte also tries to auto-open a desktop browser; the URL is the reliable path either way.

## Run — agent path (drive the review UI)

### 1. Make a fixture workspace + video

```bash
bun .claude/skills/konte-run/setup-fixture.ts   # [workspace-dir] [video-name]
```

It scaffolds a workspace (`/tmp/konte-run-fixture/ws`) and a video in it from `fixture-video.ts`, then crafts that video's `konte.state.json` + review stream so all four previewable stages render offline. It prints the **video dir** — that is the `--cwd` every command below takes.

- **direction** — the fixture video's `direction.ts`, left **un-accepted**, so the per-section acceptance gate is exercisable.
- **video** — two dummy clips (navy `old.mp4` accepted, crimson `new.mp4` the reroll); `shot.01.motion` gets both, shots 02/03 a single accepted take so the render plan resolves. Each shot also gets a `bg` image layer + `narration`/`sfx` audio, un-accepted so the audio track needs review.
- **animatic** — each shot's `first`/`last` panel gets one accepted flat-color PNG.
- **reference** — `character.png` / `bgm.mp3` / `reference-clip.mp4` are `file` assets auto-registered by file-sync (the fixture runs a read command to trigger it). All are ffmpeg-generated, overwriting the fixture video's media so none of it reaches state.

It also seeds shot-01 feedback and a handoff per stage, so notes render inline in every UI.

### 2. Start the preview server (background)

`--cwd` is the **video dir** printed by step 1 (cwd inside a video selects it; the workspace is found above it):

```bash
V=/tmp/konte-run-fixture/ws/videos/main
bun run konte --cwd $V preview video      --no-auto-close --port 4655 &
bun run konte --cwd $V preview animatic --no-auto-close --port 4656 &
bun run konte --cwd $V preview reference  --no-auto-close --port 4657 &
bun run konte --cwd $V preview direction  --no-auto-close --port 4658 &
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4655/api/state -o /dev/null && break; sleep 1; done
```

**Stop a server by its port, never by a name pattern**: `lsof -ti:<port> | xargs -r kill`. `pkill -f konte`/`pkill -f preview` is system-wide (it kills another session's server) and `-f` matches your own shell's command line, killing it (a spurious `exit 144`). Cleanup: `for p in 4655 4656 4657 4658; do lsof -ti:$p | xargs -r kill; done`.

Inspect server-side state directly — each stage has its own shape:

```bash
# video: shots[].assets[] — the reroll-vs-accepted flow
curl -s http://127.0.0.1:4655/api/state | jq '.shots[0].assets[] | select(.assetName=="motion") | {hasNewerVariant, variants:[.variants[]|{variantId,variantStatus,isNew,stale}]}'
# animatic: shots[].panels[] — one entry per panel image
curl -s http://127.0.0.1:4656/api/state | jq '.shots[].panels[] | {assetName, variantStatus, hasImage: (.imageUrl!=null)}'
# reference: flat assets[] — image/video/audio file pool
curl -s http://127.0.0.1:4657/api/state | jq '.assets[] | {assetName, mediaKind, variantStatus}'
# direction: the reviewable parts + their per-section acceptance gate
curl -s http://127.0.0.1:4658/api/state | jq '{sections, brief: [.brief[].field], shots: [.shots[].id]}'
```

### 3. Screenshot / drive the SPA

```bash
# static screenshot of the default view
bun .claude/skills/konte-run/drive.mjs --url http://127.0.0.1:4655 --out /tmp/default.png \
  --probe "document.querySelectorAll('.rt-clip-name').length + ' clips'"

# click a button by visible text, then screenshot
bun .claude/skills/konte-run/drive.mjs --url http://127.0.0.1:4655 --out /tmp/accepted.png \
  --click "Accept all" \
  --probe "document.querySelectorAll('.rt-shot--accepted').length"
```

`drive.mjs` launches its own headless Chrome, navigates, optionally clicks the first `<button>` whose text contains `--click`, evaluates `--probe`, and writes the PNG to `--out`. **Open the PNG and look at it** — a blank/error frame means it didn't render. A driver-free shot also works:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=1400,900 \
  --virtual-time-budget=9000 --screenshot=/tmp/shot.png http://127.0.0.1:4655
```

## Gotchas

- **Embedded bundle, not `dist/`.** After any `src/pages/preview/` edit you MUST run `build:embed-ui` (or `bun run build`) or you'll screenshot the old UI.
- **The render plan needs every shot ready (video only).** `video` preview's `/api/state` returns `RENDER_PLAN_FAILED: Assets without ready variants: …` if any shot's motion has no ready variant. `animatic` and `reference` previews are per-asset and tolerant: an asset with no ready variant renders empty.
- **Workspace ≠ video.** A workspace (`konte.config.json`) holds N videos under `videos/<name>/`; state, media and reviews are the **video's**. Point `--cwd` at the video dir.
- **No backend offline.** You can't `konte generate`; craft `konte.state.json` by hand (setup-fixture does this).
- **Feedback is not in `konte.state.json`.** Comments live per review stream in `review/<stage>/feedback.json` (keyed by full address), handoffs in `review/<stage>/handoffs/*.json`. Annotation coords are normalized to the frame (0–1), not pixels.
- **file-sync registers `file` assets undecided.** The fixture accepts every one but the audio, so the audio track begins needing review.
- **Crafted variants must read non-stale.** Staleness fires only on a non-null `definitionHash` mismatch or a changed `inputFingerprints` entry — so dummy variants use `definitionHash: null` + `inputFingerprints: {}`.
- **"Newer take" is a `status` question:** a take surfaces as new while its `status` is `"none"` beside an accepted one. An accept settles the rest as `"dismissed"`, so a crafted fixture flips `status` to control what needs review.
- **setup-fixture patches the fixture video by string replace.** Changing its `reference.tsx`/`video.tsx` shape can silently no-op a replace — if a fixture asset is missing, check those first.

## Troubleshooting

- `RENDER_PLAN_FAILED` from `/api/state` → a shot has no ready variant; add one (see fixture).
- UI change not visible in a screenshot → you skipped `build:embed-ui`; re-run it and restart the server.
- `drive.mjs` prints `NO_BUTTON` → the `--click` text didn't match any `<button>`; check exact visible text.
- `exit 144` (signal 16) → a `pkill -f`/`pgrep -f` whose pattern matched the running shell's own command line. Stop servers by port.
- Chrome warns about `Crash Reports`/`UPower` D-Bus → benign in a container; ignore.
