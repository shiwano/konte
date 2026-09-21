import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineDirection, defineAnimatic, asset, Composition, Panel } from "../dsl/index.js";
import { directionDefaults, testDirection } from "./helpers/direction.js";
import { moves } from "./helpers/shot.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "a", setup: "front", duration: 3, lineup: [] },
      { id: "02", role: "hero", action: "b", setup: "front", duration: 3, lineup: [] },
    ],
  },
});

describe("animatic shot chain", () => {
  it("walks the direction with undeveloped shots, which carry no panel or asset", () => {
    const sb = defineAnimatic(direction, {
      timeline: ({ pendingShot }) => ({ shots: pendingShot("01").nextPendingShot("02") }),
    });

    expect(sb.shots.map((s) => s.id)).toEqual(["01", "02"]);
    expect(sb.shots.every((s) => s.pending === true)).toBe(true);
    expect(sb.shots.map((s) => s.panels)).toEqual([undefined, undefined]);
    expect(sb.shots.map((s) => s.action)).toEqual(["a", "b"]);
  });

  it("rejects a reference into an undeveloped predecessor, which declares no panel", () => {
    expect(() =>
      defineAnimatic(direction, {
        timeline: ({ pendingShot }) => ({
          shots: pendingShot("01").nextShot("02", ({ shot }) => {
            const next = asset("next", imageComfy, {
              prompt: "b",
              image: shot("01").image("first"),
            });
            return (
              <Composition>
                <Panel src={next} {...moves} />
              </Composition>
            );
          }),
        }),
      }),
    ).toThrow(/undeveloped pendingShot/);
  });

  it("walks the direction in order and reaches an earlier shot's panels through shot()", () => {
    const sb = defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const first = asset("first", imageComfy, { prompt: "a" });
          return (
            <Composition>
              <Panel src={first} {...moves} />
            </Composition>
          );
        }).nextShot("02", ({ shot, location }) => {
          // `location` is injected from the direction on chained shots too, not just the first —
          // reference it so its presence in the `.nextShot` ctx type is locked in.
          const next = asset("next", imageComfy, {
            prompt: `b in ${location}`,
            image: shot("01").image("first"),
          });
          return (
            <Composition>
              <Panel src={next} {...moves} />
            </Composition>
          );
        }),
      }),
    });

    expect(sb.shots.map((s) => s.id)).toEqual(["01", "02"]);
    // The prev handle resolves to the previous shot's shot-local asset placeholder, so shot 02's
    // `next` asset carries a dependency on `animatic:shot.01.first`.
    expect(JSON.stringify(sb.shots[1]!.assets.next)).toContain("__konte:animatic:shot.01.first__");
    // Shot 02's direction `location` ("studio") was injected into its build ctx.
    expect(JSON.stringify(sb.shots[1]!.assets.next)).toContain("b in studio");
  });

  it("allows an empty animatic for an empty direction", () => {
    // An empty direction: the bare `[]` is the only valid timeline (there is no first shot to
    // start a chain from), so use one that actually declares no shots.
    const emptyDirection = testDirection({
      fps: 24,
      size: { megapixels: 0.001024, delivery: { width: 32, height: 32 } },
    });
    const sb = defineAnimatic(emptyDirection, {
      timeline: () => ({ shots: [] }),
    });
    expect(sb.shots).toHaveLength(0);
  });

  it("type-enforces the chain start, order, completeness, and prev's part names", () => {
    // The chain must start at the FIRST direction shot.
    void (() =>
      defineAnimatic(direction, {
        // @ts-expect-error -- "02" is not the first direction shot ("01")
        timeline: ({ pendingShot }) => pendingShot("02"),
      }));

    // An incomplete chain (stops at "01", missing "02") is not a valid terminal for `timeline`.
    void (() =>
      defineAnimatic(direction, {
        // @ts-expect-error -- animatic is missing shot "02"
        timeline: ({ pendingShot }) => pendingShot("01"),
      }));

    // `.nextPendingShot`'s id is pinned to the direction's successor, exactly like `.nextShot`'s.
    void (() =>
      defineAnimatic(direction, {
        timeline: ({ pendingShot }) => ({
          shots: pendingShot("01")
            // @ts-expect-error -- the shot after "01" is "02", not "99"
            .nextPendingShot("99"),
        }),
      }));
  });

  // A shot's own asset names are invisible to the type system (its build returns JSX), so
  // `shot` checks them at load instead: an unknown name is a throw, not a type error.
  it("throws on a name the referenced shot never declared", () => {
    expect(() =>
      defineAnimatic(direction, {
        timeline: ({ shot }) => ({
          shots: shot("01", () => {
            const first = asset("first", imageComfy, { prompt: "a" });
            return (
              <Composition>
                <Panel src={first} {...moves} />
              </Composition>
            );
          }).nextShot("02", ({ shot }) => {
            const next = asset("next", imageComfy, {
              prompt: "b",
              image: shot("01").image("nope"),
            });
            return (
              <Composition>
                <Panel src={next} {...moves} />
              </Composition>
            );
          }),
        }),
      }),
    ).toThrow(/declares no asset named "nope"/);
  });
});
