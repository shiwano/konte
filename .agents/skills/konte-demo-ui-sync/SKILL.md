---
name: konte-demo-ui-sync
description: Bring konte-demo's JSX rebuilds of the review UI and `konte settings` up to date with konte's real pages. Use when asked to sync, update or fix the demo UI, or after a change to src/pages/.
user-invocable: true
---

Bring konte-demo's rebuilds up to the konte pages they copy; done when each changed screen renders beside its real screenshot and `synced-konte-commit` names `HEAD`.

- `$DEMO` is the konte-demo workspace; ask the user for its path when it is not given.
- `$DEMO/ui/review-ui.tsx` and `settings-ui.tsx` rebuild konte's review pages and `konte settings` as React components; their props are the exported interfaces in those files.
- The screens using them are the `ShotNN` components in `$DEMO/videos/how-you-use-it/screens.tsx`, each a shot of that video's `animatic.tsx` / `video.tsx`, scrolled and zoomed by its `ev` list.
- `$DEMO/ui/synced-konte-commit` holds the konte commit the rebuilds last matched.

## 1. Find what changed

```bash
C=$(cat $DEMO/ui/synced-konte-commit)
git log --format="%h %ad %s%n%n%b" --date=short $C..HEAD -- src/pages | cat
git diff --stat $C..HEAD -- src/pages
```

Read each commit's diff under the files the map below pairs with a rebuild part. A commit that touches only `__tests__/`, `review/*.ts` logic or API code changes no picture.

Rebuild part (`review-ui.tsx`) → real source (`src/pages/preview/`):

- `ReviewFrame` header, `Switch`, submit button → `review/review-shell.tsx`, `components/review-header-actions.tsx`
- `HandoffBanner` → `components/changes-banner.tsx`
- `AgentNote`, `HumanNote`, `NoteComposer`, `AddNote`, move/roster/waiver cards → `components/comment-thread.tsx`, `components/note-input.tsx`
- `PinMark` → `components/pin-marker.tsx`, `components/pin-layer.tsx`
- `AcceptPill` → `components/accept-button.tsx`
- `ReelReview` layout, `Player`, `Transport` → `components/video-preview.tsx`
- `FeedbackPanel` → `components/target-panel.tsx`
- `Timeline` → `components/review-timeline.tsx`, `components/variant-summary-button.tsx`
- `ShotList`, `ShotCard` → `components/shot-list.tsx`
- `ReferenceReview`, `MediaTools` → `components/reference-preview.tsx`, `components/frame-overlay.tsx`
- `DirectionReview`, `DirectionSection` → `components/direction-preview.tsx`
- `DirectionRoster`, `DirectionLocations` → `components/direction/roster.tsx`; `ShotScript` → `components/direction/script.tsx`
- `DirectionFlow` pacing map → `components/direction-map.tsx`
- `CSS` constant → `styles/index.css`

Rebuild part (`settings-ui.tsx`) → real source (`src/pages/settings/`):

- `ConfigTab` → `config-tab.tsx`, `form.tsx`
- `CredentialsTab`, `builtinCredentials` → `credentials-tab.tsx`, `form.tsx`

## 2. See the real page

- Serve the stage per `konte-run` and screenshot it with its driver-free `google-chrome` command at `--window-size=1920,1080`, plus a tall one (`--window-size=1920,4200`) for a scrolling page — the rebuild lays out at 1920×1080, so pixel sizes compare directly.
- Read the exact sizes and colors from `styles/index.css` (1rem = 16px).
- The fixture lacks some states the promo shows (spoken lines, staging folded open, several takes) — build those from the component source.

## 3. Edit

- `className` takes Tailwind or classes in the file's `CSS` constant, never a Tailwind class setting a font family — it stops `generate` with a `composition-class-font-family` finding. Prefix new classes `kr-`.
- Use the real page's wording verbatim.
- No backward compatibility: rename or drop a prop when the real page did, then fix every call in `screens.tsx`.

## 4. Verify

```bash
(cd $DEMO && .konte/tools/tsc-*/tsc -p tsconfig.json)
bun run konte --cwd $DEMO/videos/how-you-use-it probe reel-thumbnails animatic:shot.<id> --at <sec>,… --force -y
```

- Capture each changed screen at a moment its `ev` list has the change in frame; Read the printed JPEGs beside the real screenshot.
- `--force` — the cache key may not cover an edit to `ui/`.
- Running the dev CLI against the demo syncs its managed files to the dev version; tell the user. If the demo's `direction.ts` / `animatic.tsx` / `video.tsx` no longer type-check against the current DSL, report it to the user rather than fixing it.

## 5. Record

```bash
git rev-parse HEAD > $DEMO/ui/synced-konte-commit
```
