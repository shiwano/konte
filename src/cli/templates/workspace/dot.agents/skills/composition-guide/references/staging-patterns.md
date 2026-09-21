# Staging patterns

## Layering: background clip + foreground overlay

```tsx
return (
  <Composition>
    <Video src={motion} />
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-xl border-4 border-amber-300/80 w-4/5 h-3/5" />
    </div>
  </Composition>
);
```

## Subtitles and a custom title / lower-third

- **`<Subtitle>` for spoken lines; a plain `<div>` + Tailwind for branded titles.**

```tsx
return (
  <Composition>
    <Video src={motion} />
    <Subtitle entries={[{ start: 1, end: 3, text: "Animatic it." }]} />
    {/* lower-third, animated in below */}
    <div
      id="lower-third"
      className="absolute bottom-[12%] left-[6%] text-white text-[2.5vmax] font-bold drop-shadow-lg"
    >
      Konte
    </div>
    <Animate
      script={({ timeline }) => {
        timeline.from("#lower-third", { opacity: 0, yPercent: 50, duration: 0.4 }, 0.3);
      }}
    />
  </Composition>
);
```

## Crossfade / transition between two clips in one shot

- **Overlap them with `start`, then fade with `Animate`.**

```tsx
return (
  <Composition>
    <Video id="a" src={clipA} start={0} duration={2} />
    <Video id="b" src={clipB} start={1.5} duration={1.5} />
    <Animate
      script={({ timeline }) => {
        timeline.set("#b", { opacity: 0 }, 0);
        timeline.to("#a", { opacity: 0, duration: 0.5 }, 1.5);
        timeline.to("#b", { opacity: 1, duration: 0.5 }, 1.5);
      }}
    />
  </Composition>
);
```

## Ken Burns (slow zoom / pan)

- **Animate `scale`/`xPercent`/`yPercent` on the clip; set `transformOrigin` to steer the zoom anchor.** — px offsets change with the canvas size.

```tsx
return (
  <Composition>
    <Video id="main" src={motion} />
    <Animate
      script={({ timeline }) => {
        timeline.fromTo(
          "#main",
          { scale: 1, xPercent: 0, transformOrigin: "50% 50%" },
          { scale: 1.15, xPercent: -3, duration: 3, ease: "none" },
          0,
        );
      }}
    />
  </Composition>
);
```

## Fades and a flash accent

```tsx
<Animate
  script={({ timeline }) => {
    timeline.from("#main", { opacity: 0, duration: 0.5 }, 0); // fade in
    timeline.to("#main", { opacity: 0, duration: 0.5 }, 2.5); // fade out: the shot's duration − 0.5, written as a literal
    // white flash on a hit
    timeline.set("#flash", { opacity: 0.9 }, 1.2);
    timeline.to("#flash", { opacity: 0, duration: 0.25 }, 1.2);
  }}
/>
```

- **`#flash` is a `<div id="flash" className="absolute inset-0 bg-white opacity-0" />` you add to the stage** — a `fromTo`/`from` holds its start values from the shot's head until it plays, so a `fromTo` flash covers the frame until its hit.

## Title reveal with easing

```tsx
timeline.from("#title", { opacity: 0, yPercent: 40, duration: 0.6, ease: "back.out(1.7)" }, 0.2);
```
