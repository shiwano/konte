# Drafts

A draft take is consecutive shots generated as one small clip, so their frames are composed across the cuts. Every camera shot's panels are drawn from a frame of one; nothing else of the take reaches the video.

## Split the shots into takes

- **`draft([ids], build)` under `drafts` in animatic.tsx** — a run of consecutive camera shots, each shot in exactly one take, addressed `animatic:draft.<name>`. An aside or a graphic shot ends the run.
- **Four or five cuts a take** — the reference slots fill first, the model's length after (`konte adapter show`).
- **Start a new take where the place changes.**
- **`drafts` declares takes only** — what a take is built from is a `reference.tsx` asset.
- **Hand it each place's reference and each subject's** — `reference.<location>`, or a `reference.tsx` asset built from it; a panel drawn from a frame of the take stands on what the take was handed.
- **`cuts((id) => text)` lays each shot's text on the direction's cut times**; length and size are derived.
- **`previous` is the take before, cut to its last seconds** — pass it as the reference clip and write the take as its continuation, in the adapter guide's notation. `undefined` on the first take and after a change of place.
- **Pass no voice reference and no stem** — a draft's sound is never used.

## Write each shot

- **Name the camera's height and angle in every shot.**
- **Write the action's first state and its last.**
- **Give a shot the words its frame needs** — the adapter guide's range is for the whole take.

## Say one thing one way across takes

- **Whatever two takes both show is written in the same words in both** — the contents of a screen, a prop's state, a costume. Two takes written differently come back different, and `previous` carries only what its last seconds show.

## Pick the frames

Draft first, panels second: `konte generate animatic` and `konte job wait` while the shots are still `pendingShot`s.

- **`konte probe cuts animatic:draft`** — each take's detected cuts beside the direction's, and a sheet with the time on every frame. A take cuts up to half a second either side of the stated time, and a large move reads as a cut: read the sheet.
- **`drafts.<name>.frame("<id>", "<name>", { at })` inside that shot's build** — `at` in seconds from the take's head. It declares `animatic:shot.<id>.<name>`.
- **Pick the frame the panel is drawn from, not the cut** — a shot can open with nobody in frame; take the frame after the entrance.
- **Write the panel prompt from that frame** — what it shows, drawn up in the adapter guide's notation.

## A second frame at the shot's end

Take the take's last frame of the shot as a second `<Panel>` where the head and the end differ by more than motion:

- **Take it** — something enters or leaves the frame for good; a figure's place or whole pose changes; what fills most of the frame changes.
- **Leave it** — only a face or the hands change; the same pose keeps moving; the figure exits and the frame ends empty.
- **Draw it from the end frame and the shot's settled first panel together** — same camera and set, the figures where the end frame has them.

## Change a composition

**A panel draws what its frame shows** — its prompt moves line, colour, expression and detail.

- **Another moment of the shot** → move `at`.
- **What the frame shows — a facing, a pose, a held prop, the set's structure, a count** → an image-edit asset between the frame and the panel (`konte adapter list`), written in the shape its guide gives.
- **Framing, size, camera position** → rewrite that shot's text in the take, `konte reroll animatic:draft.<name>`, then rewrite that shot's `at`. No other panel moves until its own `at` is rewritten.

```tsx
const frame = drafts.opening.frame("02", "draftFirst", { at: 2.15 });
const shaped = asset("shapedFrame", imageEdit, { image1: frame, prompt: "…" });
```

- **A draft is never accepted or dismissed** — the panels drawn from it are what the human signs off.
