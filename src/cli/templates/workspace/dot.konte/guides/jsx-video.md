# jsxVideo

- Motion that is a function of the shot's time (an entrance, a count-up, a chart drawing in) belongs in the shot's own `<Composition>` with `<Animate>`'s `timeline`.
- A shot's `<Animate>` that calls `requestAnimationFrame` or `setInterval` fails the load.

## What it renders

The same document as `jsxImage`, captured frame by frame from t=0 at the stage's `fps`. `duration` defaults to the length of the shot it is declared in.

```tsx
const race = asset("race", adapters.jsxVideo, {
  build: ({ width, height }) => (
    <>
      <canvas id="game" width={width} height={height} />
      <Animate
        data={course}
        script={({ data }) => {
          const ctx = (document.getElementById("game") as HTMLCanvasElement).getContext("2d")!;
          let last: number | null = null;
          const frame = (now: number) => {
            const dt = last === null ? 0 : (now - last) / 1000;
            last = now;
            // step the world by dt, then draw it
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }}
      />
    </>
  ),
});
```

Place it like any clip: `<Video src={race} />`.

## The clock

- One `requestAnimationFrame` callback per frame — advance state by `now - last`, never by a fixed step per callback.
- `performance.now`, `Date`, `setTimeout` and `setInterval` run on the frame clock; `Math.random` and `crypto.getRandomValues` draw from a fixed seed.
- Inputs through `<Animate data>`, pictures through `<Image>` — anything fetched at bake time is outside the definition hash, so changing it never stales the take.
- No sound — the clip is silent; a `<Video>` or `<Audio>` fails the load.

## Determinism

- One outcome — `reroll` and `dismiss` refuse.
- Still review work, accepted like any take.
