import { describe, expect, it } from "vitest";
import { Animate, Audio, Image, Video } from "../dsl/composition/index.js";
import { jsxImage } from "../dsl/adapters/index.js";
import type { MediaAsset } from "../dsl/builders.js";
import {
  runInDiscoveryMode,
  runInReferenceDiscoveryMode,
  runTimelineInDiscoveryMode,
} from "../dsl/shot-context.js";
import { extractRefs } from "../graph.js";
import type { LocalAssetDefinition } from "../types/index.js";

const plate = (src: string): MediaAsset<"image"> => ({ src });

const CANVAS = { size: { width: 1920, height: 1080 } };

// createDefinition reads the stage canvas off the active discovery context, so drive it through one.
function define(
  inputs: Parameters<typeof jsxImage.createDefinition>[0],
  format: Parameters<typeof runTimelineInDiscoveryMode>[2] = CANVAS,
): LocalAssetDefinition {
  const { result } = runTimelineInDiscoveryMode(
    "video",
    () => jsxImage.createDefinition(inputs),
    format,
  );
  const def = result as LocalAssetDefinition;
  if (def.kind !== "local") throw new Error("expected a local render definition");
  return def;
}

const htmlOf = (def: LocalAssetDefinition): string => (def.inputs as { html: string }).html;

describe("jsxImage", () => {
  it("builds a deterministic local 'render' definition", () => {
    const def = define({ build: () => <h1>title</h1> });

    expect(def).toMatchObject({
      kind: "local",
      operation: "render",
      mediaType: "image",
      deterministic: true,
    });
    expect(jsxImage.type).toBe("image");
  });

  it("takes its canvas from the stage, and hands the same numbers to the build", () => {
    const seen: Array<{ width: number; height: number }> = [];
    const def = define({
      build: (canvas) => {
        seen.push(canvas);
        return <h1>title</h1>;
      },
    });

    expect(seen).toEqual([{ width: 1920, height: 1080 }]);
    expect(def.inputs).toMatchObject({ width: 1920, height: 1080 });
    expect(htmlOf(def)).toContain('data-width="1920"');
  });

  it("lets an explicit size override the stage canvas", () => {
    const def = define({ build: () => <h1>title</h1>, width: 512, height: 512 });

    expect(def.inputs).toMatchObject({ width: 512, height: 512 });
  });

  it("demands a size where there is no canvas to take one from", () => {
    expect(() => jsxImage.createDefinition({ build: () => <h1>title</h1> })).toThrow(
      /needs a width and height/,
    );
  });

  it("makes every asset the tree references a dependency edge", () => {
    const def = define({
      build: () => (
        <>
          <Image src={plate("__konte:reference:background__")} fill />
          <Image src={plate("__konte:animatic:shot.01.first__")} />
        </>
      ),
    });

    expect(extractRefs(def)).toEqual(["reference:background", "animatic:shot.01.first"]);
    // The refs are also left inline in the HTML, for the backend to swap for real files.
    expect(htmlOf(def)).toContain('src="__konte:reference:background__"');
  });

  // The raw tree walk cannot see this one: `<Layer />`'s element has no props at all, and the ref
  // only appears once the function component runs. Missing it means a broken layer no gate catches.
  it("finds a ref a function component pulls in from a closure", () => {
    const logo = plate("__konte:reference:logo__");
    function Layer(): React.ReactElement {
      return <Image src={logo} fill />;
    }
    const def = define({ build: () => <Layer /> });

    expect(extractRefs(def)).toEqual(["reference:logo"]);
    expect(htmlOf(def)).toContain('src="__konte:reference:logo__"');
  });

  // A ref passed to a component that drops it still becomes an edge. The union over-reports on
  // purpose, as `partitionShotRefs` does for a composition: a spurious edge costs an ordering
  // constraint, a missing one costs a broken layer nothing catches.
  it("keeps the edge for a ref that is passed but never rendered", () => {
    function Unused(_props: { src: MediaAsset<"image"> }): React.ReactElement {
      return <h1>title</h1>;
    }
    const def = define({ build: () => <Unused src={plate("__konte:reference:logo__")} /> });

    expect(extractRefs(def)).toEqual(["reference:logo"]);
    expect(htmlOf(def)).not.toContain("__konte:");
  });

  // Neither pass can see a ref embedded in a longer string, and one left in the document renders as
  // a broken layer. Refuse the definition rather than ship that.
  it("refuses a ref embedded in a string instead of passed as a src", () => {
    expect(() =>
      define({
        build: () => (
          <div
            className="absolute inset-0"
            style={{ backgroundImage: `url(${plate("__konte:reference:logo__").src})` }}
          />
        ),
      }),
    ).toThrow(/cannot resolve into a file/);
  });

  // The capture has no clock and no frame injector.
  it("refuses a <Video> and an <Audio>", () => {
    expect(() =>
      define({ build: () => <Video src={{ src: "__konte:reference:clip__" }} /> }),
    ).toThrow(/comes out\s+black/);
    expect(() =>
      define({ build: () => <Audio src={{ src: "__konte:reference:bgm__" }} /> }),
    ).toThrow(/never heard/);
  });

  it("refuses a raw media tag no visitor can see", () => {
    expect(() =>
      define({
        build: () => <div dangerouslySetInnerHTML={{ __html: "<video src='x.mp4'></video>" }} />,
      }),
    ).toThrow(/dangerouslySetInnerHTML/);
  });

  // Its timeline never runs — nothing to reject.
  it("leaves an <Animate> alone", () => {
    expect(() =>
      define({
        build: () => (
          <div id="t">
            <Animate script={({ timeline }) => timeline.to("#t", { opacity: 1 })} />
          </div>
        ),
      }),
    ).not.toThrow();
  });

  // A load-time gate that rejects valid documents is worse than one that misses.
  it("allows author text that only looks like a placeholder", () => {
    const def = define({
      build: () => <p>Literal __konte: marker, and __konte:hello__ which addresses nothing</p>,
    });

    expect(extractRefs(def)).toEqual([]);
  });

  it("allows a media tag spelled inside script or style text", () => {
    expect(() =>
      define({
        build: () => (
          <>
            <style>{`.x::after { content: "<audio >"; }`}</style>
            <div id="t">
              <Animate script={({ timeline }) => timeline.to("#t", { opacity: 1 })} />
            </div>
          </>
        ),
      }),
    ).not.toThrow();
  });

  it("typesets with the direction's fonts and language", () => {
    const def = define(
      { build: () => <h1>タイトル</h1> },
      { ...CANVAS, typography: { lang: "ja", fonts: ["Noto Sans JP"] } },
    );

    expect(htmlOf(def)).toContain('<html lang="ja">');
    expect(htmlOf(def)).toContain("fonts.googleapis.com");
    expect(htmlOf(def)).toContain('"Noto Sans JP"');
  });

  // The reference stage carries the direction's typography, so a still declared there sets type
  // like the other two.
  it("typesets on the reference stage", () => {
    const { result } = runInReferenceDiscoveryMode(
      () => jsxImage.createDefinition({ width: 512, height: 512, build: () => <h1>タイトル</h1> }),
      () => ({
        size: { width: 1248, height: 1248 },
        typography: { lang: "ja", fonts: ["Noto Sans JP"] },
      }),
    );
    const html = htmlOf(result as LocalAssetDefinition);

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('"Noto Sans JP"');
  });

  it("takes the reference stage's canvas when given no size", () => {
    const { result } = runInReferenceDiscoveryMode(
      () => jsxImage.createDefinition({ build: () => <h1>title</h1> }),
      () => ({ size: { width: 832, height: 1248 }, typography: { lang: "ja" } }),
    );

    expect((result as LocalAssetDefinition).inputs).toMatchObject({ width: 832, height: 1248 });
  });

  // Without the opt-out the capture waits out its full 45s readiness timeout for a
  // `window.__timelines` registration a still never makes.
  it("marks the document as driving no timeline", () => {
    expect(htmlOf(define({ build: () => <h1>title</h1> }))).toContain("data-no-timeline");
  });

  it("paints an opaque backdrop by default and none when transparent", () => {
    const opaque = htmlOf(define({ build: () => <h1>title</h1> }));
    const transparent = htmlOf(define({ build: () => <h1>title</h1>, background: "transparent" }));

    // A png capture forces html/body clear, so the ground is a rule on #stage — not a full-bleed
    // element, which paints in a later stage than the build's in-flow boxes and would cover them.
    expect(opaque).toContain("#stage { background: #000000; }");
    expect(transparent).not.toContain("#stage { background");
  });

  it("makes a solid canvas out of the background alone when no build is given", () => {
    const def = define({ width: 1536, height: 1536, background: "#f3eefb" });

    expect(def.inputs.width).toBe(1536);
    expect(def.inputs.height).toBe(1536);
    expect(htmlOf(def)).toContain("#stage { background: #f3eefb; }");
    expect(extractRefs(def)).toEqual([]);
  });

  it("rejects a background that is not a hex colour", () => {
    expect(() =>
      define({ build: () => <h1>title</h1>, background: "rebeccapurple" as `#${string}` }),
    ).toThrow(/hex string/);
  });

  // The HTML is what the definition hash is taken over, so anything of the surrounding shot baked
  // into it would stale every jsxImage in a shot on a rename.
  it("does not fingerprint the shot it is declared in", () => {
    const build = () => <h1>title</h1>;
    const render = (shotId: string) =>
      htmlOf(
        runInDiscoveryMode(
          "video",
          shotId,
          () => jsxImage.createDefinition({ build }) as unknown as React.ReactElement,
          CANVAS,
        ).element as unknown as LocalAssetDefinition,
      );

    expect(render("01")).toBe(render("07"));
  });
});
