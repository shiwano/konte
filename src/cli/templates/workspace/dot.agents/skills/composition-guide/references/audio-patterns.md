# Audio in a composition — BGM, source audio, SE

**Writing `prompt`/`script` → `prompt-guide`.**

- **Adding audio auto-mints `stem` review targets** — a shot's `<Audio>`/`<Video hasAudio>` grows `shot.<id>#stem`, `soundtrack()` beds a `timeline#stem`; both appear in `konte status` labelled `audio mix` and are reviewed like compositions.
- **An `<Audio>`'s optional `id` labels its block in the review timeline** — name the dialogue lines so the human reads the track.
- **`soundtrack()` is a timeline-spanning bed** — it goes in the `soundtracks` array of the `timeline()` return.
- **Every bed states its `duck`** — required, no default: `true` drops it under the spoken lines it plays over, `false` holds its level through them (ambience, a sting). Curve details → [sound-design.md](sound-design.md).

```tsx
return (
  <Composition>
    <Video src={motion} hasAudio volume={0.8} /> {/* keep the clip's own audio */}
    <Audio id="vo" src={voice} start={0.5} fadeIn={0.1} /> {/* dialogue, cue id "vo" */}
    <Audio src={whoosh} start={1.2} volume={0.9} /> {/* SE: plays once at 1.2s */}
  </Composition>
);
```

- **The bed's `src` is any audio asset** — a shared `reference.bgm`, or an `asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" })` declared in `timeline` for a single video.
- **A bed fills its span, looping if the source is shorter; beds may overlap** — each is its own muxed track.
- **`from`/`until` anchor a bed's span to shot positions** — `{ shot: "<id>", at?: <seconds-into-that-shot> }`. Defaults: `from` omitted → timeline start; `until` omitted → timeline end; `at` omitted → that shot's head/end.
- **Times are shot-relative** — auto-follow if an upstream shot's length changes; shot ids type-checked against your `shots`.
- **Switch music mid-shot without splitting the shot** — end one bed and start the next at the same anchor (overlap + `fadeOut`/`fadeIn` to crossfade).

```tsx
soundtracks: [
  soundtrack("calm", a, { duck: true, until: { shot: "02", at: 1.5 }, fadeOut: 0.5 }),
  soundtrack("hit", b, { duck: true, from: { shot: "02", at: 1.5 }, fadeIn: 0.5 }),
],
```

## The spoken lines live on the animatic

**A shot the direction gives `script` lines must sound them there** (`SCRIPT_UNVOICED` at load otherwise) — an `<Audio>` per line in that shot's `animatic.tsx` composition. konte mixes the shot's cues, narration apart, into `animatic:shot.<id>#stem` — the one audio file an audio-driven model takes; play its take with `<Video hasAudio>`.

- **Leave a line take's clip length unset** — konte sizes it from the words and holds it inside the window the `<Audio>` plays in. Set it by hand only after hearing a take that came back rushed or padded.
- **A take that overruns its window is fitted, not cut** — `asset("vo", adapters.audioRetime, { source: raw, duration: <the window> })` moves the tempo and leaves the pitch, so the clamp takes nothing off the tail. Past ±10% it needs a `waiver: "<reason>"` — the read itself has moved by then, which is the direction's call.
- **`animatic.shot(id).stem` is konte's, not yours** — clamped to the shot's `duration` so a long voice take never decides the shot's length. Never write the mix or the trim yourself.
- **Lines on the delivered stem are a last resort** — `<Audio src={animatic.shot("01").stem} />` in the video shot, rather than feeding the stem to the model's `audio` input, and only once no adapter on the backend takes the voice into the take at all (`production-guide` step 2).
- **Narration is delivered from its own stem** — `<Audio src={animatic.shot("01").narrationStem} />` in the video shot, `start`/`volume` set there (`NARRATION_UNPLACED` if missing). No model input takes it.
- **Narration beside a wordless recording is refused** (`NARRATION_UNATTRIBUTED`) — voice it with an adapter whose spoken-text input carries its words.
- **An SE the motion must hit goes on the board if the motion model takes the stem** — the take times its action to it and carries it; `video.tsx` adds none.
- **A sound that must cross the cut belongs in `video.tsx`, not the board** — it drives neither shot's motion, and the board's `#stem` is cut to the shot.
- **Editing the board re-closes the gate** — its composition's identity covers its audio, so retiming a line ages the accept out and holds the video until it is re-reviewed.
