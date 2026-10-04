# A piece cut to a song

The song take is accepted before any shot is written. Fields → `direction-guide`'s song.md.

## 1. Declare the clock and the lyrics, no shots

- **`policy.clock`, `lyrics`, and `sequence.shots: []`.**
- **`bpm` and `beatsPerBar` are your decision** — the music model is asked for them.

## 2. Review the brief, policy and lyrics

- **Per `review-guide`, scope `direction`** — the song is refused until they are accepted.

## 3. Make the song

- **Generated → a `reference.tsx` asset at `clock.song`'s id, returned under it and fed from the direction** — the words laid out per the model's guide:

```tsx
import { lyricText } from "konte";

const clock = direction.policy.clock!;
const song = asset(clock.song, audioYue2, {
  style: `English, synth pop, bright female vocal, ${clock.bpm} BPM, ${clock.beatsPerBar}/4, four-on-the-floor kick`,
  bpm: clock.bpm,
  lyrics: direction
    .lyrics!.map((s) => `[${s.label}]\n${s.lines.map(lyricText).join("\n")}`)
    .join("\n\n"),
});
```

- **Brought → a `file` asset at that id.**
- **`konte generate reference`, then `konte job wait`** — the wait covers the reading of each take.
- **A reading failed → `konte song analyze`** — the first run downloads the vocal separator. It re-reads the current take, keeping every `konte song set` correction on it.

## 4. Check the lines, then accept

- **Preview the song and listen with its lines laid over it before accepting** — a line may be placed a line off, not only left unplaced (`lyric-unplaced`).
- **A wrong or unplaced line is the human's to fix on the song's review page** — they drag it to where it is sung.
- **Settle the song before any animatic spend** — a new take, a same-path file swap or a `konte song set --downbeat` can move the intro, and the first shot is then remade.

## 5. Write the shots in beats

- **Back to step 7** — `beats` per shot, one section's idea at a time.
