# Motion craft

Defaults for moving type, shapes and charts in `<Animate>` — the shot's `duration`, the song, the piece's established motion and a human note each override them.

## Hierarchy

- One focus at a time — elements that belong together move together; separate groups enter in reading order, the most important first.
- Every move has a job — enter, point, hand off, exit; no idle loop or wobble.
- Settle 0.5s before the cut — an exit, when there is one, is the last move.
- Same role, same motion — every label enters with one duration and ease; vary them by importance, travel distance and size, a large element moving longer than a label.

## Easing

- Entrance — `power3.out` / `expo.out`.
- Exit — `power2.in`, about ⅔ of the entrance's length.
- Overshoot — `back.out(1.4)` on one accent per shot; on everything it reads bouncy.
- `ease: "none"` — only a constant drift (Ken Burns, a ticker).

## Timing

- Duration — text entrance 0.4–0.7s; a large element 0.6–1s; an accent 0.15–0.3s.
- Stagger — 0.03–0.05s per char, 0.06–0.1s per word, 0.1–0.15s per list item or bar.
- Overlap a sequence — the next starts before the last lands (`"-=0.2"`).
- A staggered group runs `duration + (count − 1) × stagger` — a long line takes a smaller stagger or splits by words so the group settles in time.
- Hold a line long enough to read — about 0.3s per English word, 0.25s per Japanese character, after it lands.

## Per-char / per-word text — `split`

```tsx
<h1 id="title" className="text-[6vmax] font-bold">Ship it today</h1>
<Animate
  script={({ timeline, split }) => {
    const title = split("#title", { type: "words,chars", mask: "chars" });
    timeline.from(title.chars, { yPercent: 100, duration: 0.5, ease: "power3.out", stagger: 0.04 }, 0.2);
  }}
/>
```

- `mask` clips each piece to its own box — the char rises from behind a line.
- Split `"words,chars"` to move chars — `"chars"` alone can break a line inside a word.

## Line draw

```tsx
<svg viewBox="0 0 100 40" className="absolute inset-0 h-full w-full">
  <path id="line" d="M0 35 L50 20 L100 5" fill="none" stroke="white" />
</svg>
<Animate
  script={({ timeline }) => {
    timeline.from("#line", { drawSVG: "0%", duration: 1, ease: "power2.inOut" }, 0.3);
  }}
/>
```

## Chart bars and a count-up

```tsx
// 4 bars: 0.6 + 3 × 0.1 = 0.9s
timeline.from(
  ".bar",
  { scaleY: 0, transformOrigin: "50% 100%", duration: 0.6, ease: "power3.out", stagger: 0.1 },
  0.2,
);
timeline.from(
  "#total",
  { innerText: 0, snap: { innerText: 1 }, duration: 0.9, ease: "power3.out" },
  0.2,
);
```

- A count-up lands with its last bar — same start and ease, its `duration` the bars' group time.
