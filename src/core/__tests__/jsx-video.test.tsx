import { describe, expect, it } from "vitest";
import { Animate, Image, Video } from "../dsl/composition/index.js";
import { jsxVideo } from "../dsl/adapters/index.js";
import { runInReferenceDiscoveryMode, runTimelineInDiscoveryMode } from "../dsl/shot-context.js";
import { extractRefs } from "../graph.js";
import type { LocalAssetDefinition } from "../types/index.js";
import { jsxDocumentHtml } from "../dsl/adapters/jsx-document.js";
import { asJsxClipInputs } from "../jsx-render.js";

const SHOT = { size: { width: 1920, height: 1080 }, fps: 30, duration: 4 };

function define(
  inputs: Parameters<typeof jsxVideo.createDefinition>[0],
  format: Parameters<typeof runTimelineInDiscoveryMode>[2] = SHOT,
): LocalAssetDefinition {
  const { result } = runTimelineInDiscoveryMode(
    "video",
    () => jsxVideo.createDefinition(inputs),
    format,
  );
  return result as LocalAssetDefinition;
}

const htmlOf = (def: LocalAssetDefinition): string =>
  jsxDocumentHtml("jsxVideo", asJsxClipInputs(def.inputs));

const loop = () => (
  <Animate
    script={() => {
      const tick = () => requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    }}
  />
);

describe("jsxVideo", () => {
  it("builds a deterministic local 'render' video on the shot's length, frame rate and canvas", () => {
    const def = define({ build: () => <canvas id="game" /> });

    expect(def).toMatchObject({
      kind: "local",
      operation: "render",
      mediaType: "video",
      deterministic: true,
      inputs: { width: 1920, height: 1080, duration: 4, fps: 30 },
    });
    expect(jsxVideo.type).toBe("video");
  });

  it("lets an explicit duration and size override the shot's", () => {
    const def = define({ build: () => <canvas />, duration: 2.5, width: 640, height: 360 });

    expect(def.inputs).toMatchObject({ duration: 2.5, width: 640, height: 360 });
  });

  it("demands a duration outside a shot", () => {
    expect(() =>
      define({ build: () => <canvas /> }, { size: { width: 640, height: 360 }, fps: 30 }),
    ).toThrow(/pass `duration`/);
  });

  it("demands a stage with a frame rate", () => {
    expect(() =>
      runInReferenceDiscoveryMode(
        () => jsxVideo.createDefinition({ build: () => <canvas />, duration: 2 }),
        () => ({ size: { width: 512, height: 512 } }),
      ),
    ).toThrow(/frame rate/);
  });

  it("lets an <Animate> run its own clock", () => {
    expect(htmlOf(define({ build: loop }))).toContain("requestAnimationFrame(tick)");
  });

  it("drives a timeline rather than capturing a still", () => {
    expect(htmlOf(define({ build: () => <canvas /> }))).not.toContain("data-no-timeline");
  });

  it("makes every asset the tree references a dependency edge", () => {
    const def = define({
      build: () => <Image src={{ src: "__konte:reference:sprites__" }} />,
    });

    expect(extractRefs(def)).toEqual(["reference:sprites"]);
  });

  it("refuses a <Video>", () => {
    expect(() =>
      define({ build: () => <Video src={{ src: "__konte:reference:clip__" }} /> }),
    ).toThrow(/jsxVideo renders a <video>/);
  });
});
