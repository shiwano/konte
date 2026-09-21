---
name: polish-guide
description: The finishing pass before the last video review — watch the assembled cut whole, then fix the hook, the cut rhythm, the look across shots, the sound, the on-screen text and the ending inside the compositions, never by regenerating. Read when every video shot holds a self-reviewed take and the final handoff is next, or when a cut plays but reads as cheap.
user-invocable: false
---

Take an assembled cut whose every shot holds a self-reviewed take from "plays" to "finished" — one pass over the whole piece, fixed in `video.tsx`'s compositions and soundtracks, before the human sees it. Done = the reel watched whole, the signatures below cleared or declared kept, and the cut handed off with its shots in one review (`review-guide`); the export is `export-guide`'s, and a take that is wrong goes back to `generation-loop-guide`.

## Routing

- **A take is wrong** — subject, performance, a morph, motion that never came → `generation-loop-guide`; this pass never rerolls.
- **A shot is wrong** — order, a missing shot, a `duration` → `direction-guide`.
- **What plays where** — layers, where music enters and leaves, ducking, cut-crossing sound → `composition-guide`'s sound-design.md.
- **The mechanics of a fix** — `<Video>` windows, `<Animate>`, `<Subtitle>`, `soundtrack()`, CSS on a clip → `composition-guide`.

## 1. Watch it whole before touching anything

- **Walk the reel once as a viewer, and write the read down in chat first** — `konte probe reel-thumbnails video`, then `konte probe reel-audio video`, in order, one line per shot: what you took to have happened and what you felt.

## 2. The hook

- **Window the first shot on `brief.hook`** (none → the first shot's `action`) — slide `mediaStart` so its first second holds the frame that sentence names, not the calm before it.
- **Sound is on from frame one** — ambience under the first frame; a silent head reads as a broken file.
- **A title never delays the hook** — it rides over the first shot (an `<Animate>` reveal) or lands after it.

## 3. Rhythm inside the shot

- **The shot's length is the direction's; which part of the take fills it is yours** — a take longer than the shot is windowed by `mediaStart`: slide the window so the movement peaks near the cut, and the cut lands on the action rather than after it.
- **Keep the generative tail outside the window** — a motion model smears its last frames; `konte probe motion video` shows where each strip degrades. Choose `mediaStart` so `mediaStart + duration` ends before the damaged tail; move the window earlier when needed.
- **A held frame earns its hold with change** — a slow `<Animate>` push, a reveal, a light change; a frame held past its content is where the eye leaves. A hold the take cannot fill is a `duration` note for `direction-guide`.
- **Read three cuts at a time** — a run whose shots all move at one speed, or all hold, is a metronome whatever the durations; vary what moves.

## 4. Look across shots

- **Read the sheet as one sheet** — `konte probe contact-sheet video` tiles each shot's in and out frames; a shot whose palette, contrast or black level breaks from its neighbours, or a boundary where A's out frame and B's in frame differ in brightness, is named in the handoff, never color-corrected in the composition — a CSS `filter` or tint overlay flattens the picture.
- **One vignette, grain or letterbox for the whole piece, or none** — an overlay some shots carry and others don't reads as a seam.

## 5. Text on screen

- **Subtitles from `script`, styled once** — one `<Subtitle className>` for the piece, at most two rows; a line that needs three is broken in the entries.
- **Keep text out of the edges** — 5% from every edge; a 9:16 delivery keeps the bottom sixth and the right edge clear for the platform's own controls.
- **Telop lands on a hold** — where the frame is still, for the time it takes to read twice.
- **Every family on screen is one `direction.policy.fonts` declares** — a typeface the machine happens to have is a seam.

## 6. Transitions

- **The cut is the default** — a dissolve says time passes or place changes; between two shots of one continuous action it is a smear. A fade in at the head that never delays the hook, a fade out at the tail, and nowhere else without a reason the direction wrote (a flash on a hit, a whip on a chase).
- **A transition hides nothing** — a dissolve over a jump cut is a slow jump cut; fix the cut at the window, or the shot at the direction.
- **A boundary the direction declares `join: "continuous"` takes no transition at all** — there is no cut there to soften, and anything laid over it puts one back.

## 7. The end

- **The last frame is the takeaway** — `brief.audience`'s sentence as a picture (none → the last shot's `action`); hold it.
- **An end card comes after the last image, never instead of it.**

## Signatures of generated video

Name the ones the reel carries; clear each, or say in the handoff why it stays.

- **Unmotivated camera drift** — every shot floating or slowly pushing. Clear: a tighter window; let one shot move and the rest sit. A drift no window escapes → `generation-loop-guide`.
- **Everything at half speed** — every action slower than life. Clear: window to the action's real time. Slow end to end → `generation-loop-guide`.
- **Idle breathing** — hair, cloth and light moving while nothing happens. Clear: §3's held frame.
- **The model's default length everywhere** — every shot the clip cap long. Clear: §3's window.
- **A morph** — an identity, a hand or an object changing inside the take or across the cut. Clear: a window that ends before it starts. A morph inside every window → `generation-loop-guide`.
- **A silent picture** / **Music as wallpaper** — sound only where a line is; one bed at one level from first frame to last. Clear: sound-design.md.
- **Text that floats** — subtitles in a default face at a default size, unanchored to the picture. Clear: §5.
- **The default look** — saturation, sharpness and rim light past what `brief.look` names. Clear: name it in the handoff; where every take carries it, a prompt fix for the next piece.

## Verify

- `konte probe reel-audio video` — no ⚠ at the head or the tail, and no silent shot you did not choose.
- `konte probe reel-thumbnails video` — the first frame carries the hook, the last carries the takeaway.
- `konte status -v` — the pass's `#composition` and `#stem` targets sit under Needs review beside the takes; one `konte preview video` reviews both.

## Pitfalls

- **Polishing a wrong take** — any morph the window shows; route it back.
- **Running polish per sequence** — rhythm, look and score read across the whole piece; run it once, before the last handoff.
- **Running polish after the human accepted the cut** — every composition it touches comes back for review; what they signed off is what ships, and a further pass is theirs to ask for.
