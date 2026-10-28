---
name: composition-guide
description: Read when writing or fixing a shot's Composition JSX in animatic.tsx or video.tsx — layers, captions, <Animate>, cutins, graphic shots — or its sound (<Audio> cues, soundtrack() beds, where music enters, levels).
user-invocable: false
---

Compose layers, captions, animation and sound in `animatic.tsx` or `video.tsx`; done = the reel probes confirm their timing and placement. Generating assets is outside this guide.

## Routing

- Choosing or placing any sound — an `<Audio>` cue, a `soundtracks` bed, `<Video hasAudio>` → [sound-design.md](references/sound-design.md) before the first one; [audio-patterns.md](references/audio-patterns.md) for its props and stems
- A piece cut to a song (`policy.song`) → [song.md](references/song.md) before any sound, beat-timed move or lyric
- A graphic shot, or type / shapes / a chart that move — a title's entrance, a count-up, a line drawn → [motion-craft.md](references/motion-craft.md) before its `<Animate>`
- Any HTML element over or beside the clip — a date or caption card, a title / lower-third, a layer over every shot (`overlay`), a crossfade, Ken Burns, a fade or flash → [staging-patterns.md](references/staging-patterns.md) before writing it
- Whether a shot gets that `duration` or that sound at all → `direction-guide`

## The composition is a reviewable target

- `video:shot.<id>#composition` is reviewed apart from the clips it arranges — no rerolls: edit the JSX and it re-renders.
- An upstream clip change makes it `input-stale` — it returns to `konte status -v`'s Needs review; `konte inspect video:shot.<id>#composition` names the changed input.
- Feedback lands on `video:shot.<id>`, not `#composition` — `konte review feedback list video:shot.<id>`; fixing the JSX or the upstream clip marks it addressed on the next accept.

## Components

```tsx
import {
  Composition,
  Video,
  Audio,
  Image,
  Subtitle,
  Animate,
  Cutin,
  soundtrack,
  asset,
} from "konte";
```

- `<Composition>` — root, one per shot. Injects HTML scaffold, GSAP 3.15 with SplitText and DrawSVG, Tailwind v4, `#stage`.
- `<Video src={asset} />` — a video clip on the timeline, a full-stage cover-fit layer; Tailwind classes in `className` override that (`left-0 top-0 w-1/3 h-1/3` for an inset). Defaults to `muted` + `playsInline`. Props: `src` (MediaAsset), `start`, `duration`, `mediaStart`, `playbackRate` (source s per timeline s; a `hasAudio` track follows it, pitch kept), `hasAudio`, `volume`, + any `<video>` attr (`id`, `className`, `style`)
- `<Audio src={asset} />` — a one-shot sound in a shot (SE, sting, dialogue, narration). Plays once at full length; may extend past the shot. Props: `src`, `id` (cue handle), `start`, `duration`, `mediaStart`, `volume`, `fadeIn`, `fadeOut`, + any `<audio>` attr. With `mediaStart` omitted, the take's leading silence is skipped, so `start` is where the sound lands
- `<Image src={asset} />` — a still image on the timeline (logo, character, product, plate, overlay). Whole shot unless windowed; at its pixel size unless `fill` makes it a full-stage cover-fit layer. Props: `src` (MediaAsset), `start`, `duration`, `fill`, + any `<img>` attr (`alt`, `className`, `style`)
- `<Subtitle entries={[...]} />` — timed text. Defaults to bottom-center 5% up, white, `text-[1.875vmax] font-semibold drop-shadow-lg`; a portrait canvas sits it a sixth up at `text-[3.25vmax]`, rendered above clips. Props: `entries: { start, end, text }[]`, `lineClassName` / `lineStyle` (the text's `<span>`), + any `<div>` attr
- `<Cutin at size inset>` — the shot's declared `cutin`, over the whole shot: `at` a corner (default `bottom-right`), `size` a fraction of canvas width, `inset` the edge gap. Holds that frame's `<Panel>`s on the animatic, its `<Video>` on the video.
- `<Animate script={...} />` — GSAP animation for the shot. Props: `script: ({ timeline, split, data }) => void` — `split(selector, { type, mask? })` returns `{ chars, words }`, each a tween target; inferred inline; `import type { GsapTimeline }` only for a callback lifted out of the JSX. `data` — JSON (an imported `.json`, a computed series) the script reads, typed

Plus any HTML element, inline SVG, Tailwind v4 class, inline `style` or CSS `filter` — overlays, titles, frames, vignettes.

Gotchas:

- A component prop that takes any asset is `MediaAsset<"image">` / `<"video">` / `<"audio">`
- A px font size is a different fraction of each canvas size — use `text-[Nvmax]` (1% of the longer edge) to keep text a constant fraction.
- A clip's own audio needs `hasAudio` — without it the track is dropped: `<Video src={motion} hasAudio volume={0.8} />`.
- `volume` is relative gain, 0–3.98 (+12 dB), 1 = unity — same on `<Audio>`, `<Video>`, `soundtrack()`.
- `<Animate>` assigns no ids — give the element an `id`/`className` and target it by CSS selector (`"#title"`, `".badge"`). A selector never reaches another shot's element. Sibling `<Animate>`s each start at 0 of the shot's clock, so a component can carry its own.
- A `fromTo` / `from` timed after 0 renders its start values from the shot's head — pass `immediateRender: false` and put the pre-cue state in the element's CSS (`opacity-0`), or `set` the start values at the cue and `to` from there.
- `<Animate script>` is serialized to source and run in the browser, closing over nothing — an import, a module constant, a helper, a value from the shot callback (`script`, an asset): each is a `ReferenceError` there and nothing flags it here. Inline every value or pass it as `data`; keep the callback an arrow or function expression. A synchronous throw drops the tweens after it and paints a red banner over the shot; one from a `timeline.call` callback or an `async` script fires later, uncaught.

## Graphic shots

- Finished on the board — animatic.tsx's `graphicShot` is the picture itself: components, `<Image>` layers, `<Animate>`; no `<Panel>` outside `<Cutin>`. video.tsx's `graphicShot` imports and places the same component.

## Fonts

- The piece's web fonts are declared on `direction.policy.fonts` — Google Fonts family names, every shipped weight requested, laid on the composition body.
- Never a Tailwind arbitrary-value class (`font-[Inter]`) — the export embeds faces by reading the HTML, and a class's CSS does not exist until the browser has run.

## Timing model

- Size/fps come from `format`, shot length from the shot's `duration` — components read them; don't pass them.
- Everything is in seconds on the shot's own clock, from `0`.
- `start` — when the clip appears (default `0`).
- `duration` — how long it shows. `<Video>`/`<Image>` default to the shot duration; `<Audio>` to the full source.
- `mediaStart` — offset _into the source file_ (trim the head); sequence sub-clips of one take with it. Leave it unset on a take generated from its panels.

```tsx
//        timeline:  0 ----------- 1 ----------- 2 ----------- 3
<Video src={a} start={0} duration={2} />               {/* shows 0–2s of timeline */}
<Video src={b} start={1.5} duration={1.5} mediaStart={4} /> {/* shows 1.5–3s, from 4s into b */}
```

- GSAP `position` (3rd arg of `to`/`from`/...) uses the same clock: absolute seconds (`0`, `1.5`) or relative (`"+=0.5"`, `"<0.2"` = 0.2s after the previous tween starts).
- Relative positions count from the tweens added so far, never the shot's end — a tail move takes an absolute literal.

## Verify

- `konte probe contact-sheet video` / `reel-audio video` — captions, transitions, the audio timeline.
- `konte probe motion video:shot.<id>#composition --at <sec>` — each `<Animate>` move.
- An element positioned in % over an image (a box around a screenshot row) — `konte probe image <image> --grid` to measure it.
