# Subtitled lines

- A spoken line's subtitle is an entry naming it (`shot`, `line`) in the `overlay`'s `<Subtitle>`, never `start` / `end` — timed where the reel says it, it follows a reroll or a retimed shot. `konte probe reel-lines <stage>` lists each line's clauses and seconds.

```tsx
<Subtitle
  entries={[
    { shot: "04", line: 1, text: "No, I can't say I have." },
    {
      shot: "03",
      line: 1,
      parts: [
        ["ワトスン、", "Watson,"],
        ["金儲けの機会だよ。", "there's money in this."],
      ],
    },
    { shot: "05", line: 2, take: "v-…", pauses: [2], text: ["…", "…"] },
  ]}
/>
```

- `line` numbers the shot's `script` from 1; `parts` name the line's own words, in order.
- A language `probe reel-lines` does not hear → `pauses`, numbered on the take it lists, split that whole take; a reroll raises `subtitle-pauses-stale`.
