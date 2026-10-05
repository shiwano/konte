---
name: arch-audio-guide
description: Read when touching audio — one-pass muxing after concat, soundtrack() beds, <Audio>, <Video hasAudio>, the song bed, stems, and the definition-hash exclusion.
user-invocable: false
---

How konte's audio subsystem builds the final mixed track. Not general composition rendering.

## Muxing model

All standalone audio is **muxed onto the final video in one pass after the shots are concatenated**, never baked into a shot composite; offsets accumulate from the ffprobed shot durations. The composition's elements are the source of truth: **HyperFrames mixes them live for the preview; konte's ffmpeg reconstructs them for the render**, from the video track only.

## Components

- **`soundtrack()`** — a bed in the timeline's `soundtracks`, spanning its `from`/`until` shot anchors, looping if the source is shorter.
- **`<Audio>`** — plays once at full length and may cross a cut.
- **The song bed** — with `policy.song`, the song under the whole timeline (`mixedSoundtracks`): unlooped, unducked, −14 LUFS, outside `timeline#stem`; doubling it is `SONG_DOUBLED`.
- **`<Video hasAudio>`** — contributes the clip's embedded audio as another muxed track, from the original, pre-upscale source. The track carries the shot's cue kind, so a line inside the picture ducks a bed and is levelled like a cue; a shot with no lines is left where it plays.

## Preview parity

The preview runtime plays `<audio>` only: it schedules `audio[data-start]` into a WebAudio transport and force-mutes every media element while it is active, so `buildEmbeddedAudioTags` mirrors each `<Video hasAudio>` as an `<audio>` on the same source, in the preview HTML only.

`boundOpenAudio` bounds every open-ended preview `<audio>` to its take's recorded length less `data-media-start`; the runtime's seek sync would otherwise seek it past its source and error it for good.

The reel's **preroll** (`preview-preroll.ts`) moves the picture alone: a shot's opening `<video>` opens its window a lead early, hidden by its shot host's window, so the cut reveals a clip already running. The shift comes out of `data-media-start`; a clip on its take's first frame gets a cached picture-only copy (`padVideoClip`) holding that frame in front, with a cloned tail keeping EOF clear of the window. A late start stays late past the cut (the runtime never re-syncs a playing `<video>`), so the reel's **warm-up** seeks each clip to its in-point before its window, waking one the browser suspended.

A bed's duck and fades reach the preview as a volume lane (`bedVolumeLane`, `data-automation`). The transport does not loop buffers, so gaps remain:

- **A bed that `shouldAutoLoop` loops in the mux does not loop in preview.**
- **`volume` is gain up to `MAX_AUDIO_GAIN`** (+12 dB, `audio-gain.ts`); `assertAudioGain` refuses more at load (`AUDIO_GAIN_INVALID`).

## Mixing & caching

- `audio-level.ts` derives source gains from recorded measurements for preview/render; its adjustment records also explain `probe reel-audio`. The final mix applies a limiter with no further loudness normalization.
- An sfx cue without `mediaStart` skips its take's lead-in (`cueLeadIn`).
- The picture composition's definition hash is **audio-independent**: `stripAudioFromHtml` drops the `<audio>` elements and `data-has-audio`/`data-volume` before hashing, so an audio-only edit never re-renders or re-upscales a shot.

## Stems

Audio's review/accept identity lives in **stems** — no-job materialized leaves alongside the shot compositions: a per-shot `shot.<id>#stem` (the shot's `<Audio>`/`<Video hasAudio>` cues) and one `timeline#stem` (the `soundtrack()` beds). At discovery each shot's refs are partitioned (`partitionShotRefs`) into `pictureRefs` (feed the composition) and `stemRefs` (feed the stem); a `<Video hasAudio>` source is in both. A stem's definition hash is the resolution-independent audio structure; its input fingerprints track the resolved audio sources — so it goes stale (and its accept re-opens) when an audio source changes, independent of the picture. `timeline#stem` covers the beds alone (`timelineStemRefs`); a duck envelope is signed off on the lines' shot stems. A shot whose last cue is removed keeps its accepted stem as review work (`removedShotStemAddresses`) until the shot's accept releases it. With `policy.clock` a board `#stem` also mixes, unplayed, the shot's span of the song (`songCue`); a `<Video>` of a take built on it gets a derived `mediaStart` (`song-window.ts`). Accept is folded: accepting a shot accepts its composition **and** its stems; the beds are accepted via `timeline#stem`. Accept/cascade rules: see `arch-review-system-guide`.
