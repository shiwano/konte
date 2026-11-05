# A piece adapted from a source

The source settles the story; what you pitch and the human decides is the adaptation — what is chosen, how it is compressed, how it is shown.

## Read it

`konte-source-reader` subagents write the original's digest; you read it through `konte source show` and the chunk files it names, never the original through.

- `konte source import text|comic|clip <file>` — its Next steps spawns the reader, which finds the part the human named and answers its span.
- A URL → download the whole work's file yourself (the text, EPUB, PDF, comic archive or video, not a page), even when only a part is wanted; a text that comes zipped → unpack it and import the one file that is the original.
- None named → the reader reads the whole work; settle the span with the human off `konte source show`.
- A span read alone misses looks written earlier — a name `konte source show` lists with no look: a reader on the chunks before the span. Still none → yours to fill, marked in the treatment.

## Adapt

- Select — the default is the span at the original's pace: every scene kept, every line as written, near the length `konte source show` heads the span with — less where a character recounts events the piece shows instead. A shorter runtime is a compression the human picks; each runtime option names the scenes it keeps out of the span's and the ones it drops.
- Compress — merge characters and events; cut only what leaves the therefore/but chain intact (story.md's deletion test).
- Externalize — a scene carried by interior monologue (`interior: true`) becomes a visible action, a prop, or narration (`narrator`); relying on narration is the human's call.
- Dramatize — a summary in the prose ("three years passed") becomes one picture a shot can show.
- Lines — kept as written unless the human picked a compression; the original off the scene's chunk file (a comic's off `konte source show --at <page>`); every changed line goes in the adaptation map.
- Translate — a source in another language than the piece: settle the translation policy once (faithful or colloquial) in the treatment; only a line trimmed or changed beyond translation goes in the map.
- Fill in — what the medium leaves open (prose: looks, style, framing, timing; a script: looks, style) is yours to propose; mark everything filled in the treatment.

## Comic pages as references

- Write the page at full size with `konte source show --at v1.p31`, copy it to the video's `assets/files/`, and bring it in as a `file` asset; cut a face or a figure out with `imageCrop`. Never reference `source/` directly.
- Rights are the human's to judge — never ask about them or record them.

## Write it back

The treatment carries "how I read it" — who each person is (two names, one person; merged ones included), the span's plot, what pays off what, how the main scenes are read.

In `direction.ts`, `brief.source` names the span and the adaptation map's summary:

```ts
brief: { logline: "…", source: { span: "c3-c5", keep: ["…"], drop: ["…"] } },
```
