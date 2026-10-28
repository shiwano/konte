---
name: konte-run
description: Build, serve and drive konte's preview/review UI offline. Use to hand the user a live URL for their own browser, or to screenshot and click a review-UI change with headless Chrome.
user-invocable: true
argument-hint: "[show|drive] [video|animatic|reference|direction]"
---

Serve konte's review UI (`konte preview`, a React SPA) offline from a crafted fixture state and dummy media, for the human's browser or driven with headless Chrome. Run everything from the repo root.

## Routing (`$ARGUMENTS`)

The first argument picks the mode, an optional second the stage (`video` default; also `animatic` / `reference` / `direction`). With no arguments, infer from the request — default `show video`.

- `show` → serve a live preview for the human, hand over the URL, leave the server up. No driver.
- `drive` → agent path: headless Chrome screenshots / clicks via `drive.mjs`.

`bun`, `google-chrome`, `ffmpeg` are on PATH. `bun install` if `node_modules` is absent.

## Build — required after any `src/pages/preview/` edit

The server serves the embedded bundle (`src/core/generated/ui-assets.ts`); building only `dist/` screenshots the old UI. Restart a running server after rebuilding.

```bash
bun run build:ui:preview  # bundle SPA -> src/pages/preview/dist/
bun run build:embed-ui    # embed dist -> src/core/generated/ui-assets.ts
# (or `bun run build` for everything)
```

## Run — show the preview to the human

1. If the user's workspace already has generated media, `--cwd` is that video dir (`<workspace>/videos/<name>/`); otherwise make a fixture (agent path step 1).
2. Serve it in the background. `--no-auto-close` is essential — without it the server exits when the auto-opened browser disconnects, before the user looks.

   ```bash
   bun run konte --cwd <video-dir> preview video --no-auto-close --port 4655 &
   for i in $(seq 1 30); do curl -sf http://127.0.0.1:4655/api/state -o /dev/null && break; sleep 0.5; done
   ```

3. Give the user the URL (`http://localhost:4655`) and leave the server running — WSL2 localhost-forwarding lets a Windows browser reach it; konte's own browser auto-open is unreliable.

## Run — agent path (drive the review UI)

### 1. Make a fixture workspace + video

```bash
bun .agents/skills/konte-run/setup-fixture.ts   # [workspace-dir] [video-name]
```

It scaffolds a workspace (`/tmp/konte-run-fixture/ws`) and a video from `fixture-video.ts`, then crafts its `konte.state.json` + review stream so all four stages render offline. It prints the video dir — the `--cwd` below.

- direction — the fixture video's `direction.ts`, left un-accepted, so the per-section acceptance gate is exercisable.
- video — two dummy clips (navy `old.mp4` accepted, crimson `new.mp4` the reroll); `shot.01.motion` gets both, shots 02/03 a single accepted take so the render plan resolves. Each shot also gets a `bg` image layer + `narration`/`sfx` audio, un-accepted so the audio track needs review.
- animatic — each shot's `first`/`last` panel gets one accepted flat-color PNG.
- reference — `character.png` / `bgm.mp3` / `reference-clip.mp4` are `file` assets registered by file-sync, which the fixture runs. All media is ffmpeg-generated, overwriting the fixture video's media.
- shot-01 feedback and a handoff per stage, so notes render inline in every UI.

### 2. Start the preview servers (background)

```bash
V=/tmp/konte-run-fixture/ws/videos/main
bun run konte --cwd $V preview video      --no-auto-close --port 4655 &
bun run konte --cwd $V preview animatic --no-auto-close --port 4656 &
bun run konte --cwd $V preview reference  --no-auto-close --port 4657 &
bun run konte --cwd $V preview direction  --no-auto-close --port 4658 &
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4655/api/state -o /dev/null && break; sleep 1; done
```

**Stop a server by its port, never by a name pattern** — `pkill -f konte` is system-wide (kills another session's server) and matches your own shell's command line (a spurious `exit 144`, signal 16). Cleanup: `for p in 4655 4656 4657 4658; do lsof -ti:$p | xargs -r kill; done`.

Inspect server-side state — each stage has its own shape:

```bash
# video: shots[].assets[] — the reroll-vs-accepted flow
curl -s http://127.0.0.1:4655/api/state | jq '.shots[0].assets[] | select(.assetName=="motion") | {hasUndecidedBesideAccepted, variants:[.variants[]|{variantId,variantStatus,undecidedBesideAccepted,stale}]}'
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
bun .agents/skills/konte-run/drive.mjs --url http://127.0.0.1:4655 --out /tmp/default.png \
  --probe "document.querySelectorAll('.rt-clip-name').length + ' clips'"

# click a button by visible text, then screenshot
bun .agents/skills/konte-run/drive.mjs --url http://127.0.0.1:4655 --out /tmp/accepted.png \
  --click "Accept all" \
  --probe "document.querySelectorAll('.rt-shot--accepted').length"
```

`drive.mjs` launches headless Chrome, clicks the first `<button>` whose text contains `--click`, evaluates `--probe`, and writes `--out`. Open the PNG — a blank/error frame means it didn't render. Driver-free:

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=1400,900 \
  --virtual-time-budget=9000 --screenshot=/tmp/shot.png http://127.0.0.1:4655
```

## Gotchas

- Video preview needs every shot ready — `/api/state` returns `RENDER_PLAN_FAILED` (`N asset(s) have no ready variant`) if any shot's motion has no ready variant; add one. `animatic` / `reference` render an asset with no ready variant empty.
- Feedback is not in `konte.state.json` — comments live in `review/<stage>/feedback.json` (keyed by full address), handoffs in `review/<stage>/handoffs/*.json`. Annotation coords are frame-normalized (0–1).
- file-sync registers `file` assets undecided; the fixture accepts all but the audio, so the audio track needs review.
- Crafted variants must read non-stale — staleness fires only on a non-null `definitionHash` mismatch or a changed `inputFingerprints` entry, so dummy variants use `definitionHash: null` + `inputFingerprints: {}`.
- A take is badged new while its `status` is `"none"` and it is not stale; beside an accepted one it is also `undecidedBesideAccepted`, which the reel shows in the accepted one's place. An accept settles the rest as `"dismissed"`. Flip `status` to control what needs review.
- setup-fixture patches the fixture video by string replace — a changed `reference.tsx`/`video.tsx` shape can silently no-op it; check those first if a fixture asset is missing.
- `drive.mjs` prints `NO_BUTTON` → the `--click` text matched no `<button>`; check the exact visible text.
- Chrome `Crash Reports`/`UPower` D-Bus warnings → benign; ignore.
