# videoFrame

## Chaining past a model's maximum duration

A motion model caps its clip length (Hailuo H3 tops out near 15s). Generate a longer take in segments, each conditioned on the frame the previous one ends on.

```tsx
const CUT_A = 14.5;

const rawA = asset("motion_a", someI2V, { image: first, ... });
const seam = asset("motion_a_end", adapters.videoFrame, { source: rawA, at: CUT_A });
const rawB = asset("motion_b", someI2V, { image: seam, ... });
```

The segments are cut in the composition, not on disk — `at` and the clip's `duration` name the same instant:

```tsx
<Video src={rawA} duration={CUT_A} />
<Video src={rawB} start={CUT_A} duration={CUT_B} />
```

## Where to cut

- A generative motion model degrades across its last frames — cut a few frames short of the end, keeping that tail out of both the delivered clip and the next segment's conditioning, where it compounds across every seam.
- Leave `at` at its `"last"` default only for a clip nothing continues from.

## When not to chain

- Where the picture is meant to change — a costume change, a time jump, a new layout — author the discontinuity as an animatic panel and condition the next segment on that panel instead.
- Those segments generate in parallel; a chain is accepted one link at a time.
