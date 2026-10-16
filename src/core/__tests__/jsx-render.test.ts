import { describe, expect, it } from "vitest";
import { JSX_VIDEO_CLOCK_SCRIPT } from "../jsx-render.js";

// The engine's pre-head clock, reduced to what the script wraps: a time and a seek.
function bakeWindow() {
  let time = 0;
  const window = {
    performance: {},
    Date: function FrameDate(...args: number[]) {
      return new Date(args.length ? args[0]! : time);
    },
    __HF_VIRTUAL_TIME__: {
      getTime: () => time,
      seekToTime: (ms: number) => {
        time = ms;
        return ms;
      },
    },
  } as unknown as {
    __HF_VIRTUAL_TIME__: { seekToTime: (ms: number) => number };
    performance: { now: () => number };
    Date: DateConstructor;
    setTimeout: (fn: () => void, ms: number) => number;
    setInterval: (fn: () => void, ms: number) => number;
  };
  const body = JSX_VIDEO_CLOCK_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  const math = Object.create(Math) as Math;
  Function("window", "Math", "console", body)(window, math, { error: () => {} });
  return { window, math, seek: (ms: number) => window.__HF_VIRTUAL_TIME__.seekToTime(ms) };
}

describe("JSX_VIDEO_CLOCK_SCRIPT", () => {
  it("fires timers on the frame clock, each at its own due time", () => {
    const { window, seek } = bakeWindow();
    const fired: string[] = [];
    window.setInterval(() => fired.push("tick"), 10);
    window.setTimeout(() => fired.push("once"), 15);

    seek(33);

    expect(fired).toEqual(["tick", "once", "tick", "tick"]);
  });

  it("reads each timer's due time from performance.now and Date inside its callback", () => {
    const { window, seek } = bakeWindow();
    const seen: number[][] = [];
    window.setInterval(
      () => seen.push([window.performance.now(), window.Date.now(), new window.Date().getTime()]),
      10,
    );

    seek(33);

    expect(seen).toEqual([
      [10, 10, 10],
      [20, 20, 20],
      [30, 30, 30],
    ]);
    expect(window.performance.now()).toBe(33);
    expect(new window.Date(5).getTime()).toBe(5);
  });

  it("brings a timer that re-arms itself to the frame, counting from its own due time", () => {
    const { window, seek } = bakeWindow();
    const at: number[] = [];
    let now = 0;
    const step = () => {
      now += 10;
      at.push(now);
      window.setTimeout(step, 10);
    };
    window.setTimeout(step, 10);

    seek(33);

    expect(at).toEqual([10, 20, 30]);
  });

  it("ends a chain of zero-delay timers at the frame", () => {
    const { window, seek } = bakeWindow();
    let count = 0;
    const again = () => {
      count++;
      window.setTimeout(again, 0);
    };
    window.setTimeout(again, 0);

    seek(5);

    expect(count).toBe(6);
  });

  it("draws Math.random from a fixed seed", () => {
    const draws = [bakeWindow(), bakeWindow()].map(({ math }) => [math.random(), math.random()]);
    expect(draws[0]).toEqual(draws[1]);
  });
});
