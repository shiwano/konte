# A piece cut to a song

```ts
policy: {
  …,
  song: "song",
},
lyrics: [
  { label: "Verse", singer: "mika", lines: ["Lights down, desk against the wall", …] },
  { label: "Chorus", singer: ["mika", "ren"], lines: ["Hit the light", { text: "…", singer: "ren" }] },
],
```

- **`song` names the `reference:<id>` the piece is cut to** — `song-unreferenced` until `reference.tsx` returns it.
- **Every span is `beats`, a positive whole number; `duration` is a type error** — a shot's seconds follow the song's take; the first shot also holds the take's intro before beat 0.
- **A shot has no seconds until a take of the song is read** — a board or video shot refuses to build (`SONG_UNREAD`) before then.
- **A half-beat cut is `beats: 1.5 as number`** — the literal is refused; waive `off-grid-duration_<shotId>` with the reason.
- **Cutting on the beat inside one setup** — each consecutive pair on it declares a `join` (`join-undeclared`), per [lineup.md](lineup.md).
- **`lyrics` is the song's sections in order** — `singer` a `characters` id, or several singing together, on the section and overridden per line; a singer needs no voice, and no reference unless a `lineup` holds them.
- **Never write a line's time** — where the take sings it is read off the take and corrected on the song's review page.
