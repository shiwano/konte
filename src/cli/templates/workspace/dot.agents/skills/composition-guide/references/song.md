# Composing on a song

- **konte lays the song under the whole timeline and puts each board shot's span of it in the shot's stem** — no `<Audio>` or bed of the song anywhere.
- **Time a hit to the song with `ctx.beat(n)`** — the second of the shot's `n`th beat; never seconds counted from the shot's head. The beats follow the take, tempo changes included; the first shot holds the intro, and its `beat(0)` is the first bar.
- **Lyrics on screen go in the `overlay`** — `<Subtitle entries={ctx.lyrics} />` there keeps a line sung across a cut as one caption ([staging-patterns.md](staging-patterns.md)). A shot's own `ctx.lyrics` is in shot seconds, a line begun before the shot starting at 0.
- **A prompt quotes a line's words, never its time** — a new take of the song moves each line by frames, and every take whose prompt carried the time goes stale.
- **The song is the main audio** — SE and ambience sit under it; no score of your own.
- **A motion model hears `animatic.shot(id).songStem`** — the vocals of the lines a singer in frame sings, else the instrumental. konte fills an input `adapter show` marks `stem`; a reference audio the prompt tags takes it by hand.

## Spoken lines

- **The video shot places each line the board voiced** — `<Audio src={animatic.shot("01").audio("line1")} start={…} />` at the second the board's cue starts (a voice from the reference: `reference.<id>`); the take is a `<Video>` alone.
- **A mouth off its line → move that `<Audio start>` a frame at a time** — the take's `mediaStart` is konte's; a reroll needs the move redone. A mouth nowhere near its line → `generation-loop-guide`.
