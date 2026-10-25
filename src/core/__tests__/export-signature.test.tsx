import { describe, expect, it } from "vitest";
import { Audio, Composition } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineDirection, defineVideo } from "../dsl/index.js";
import { computeExportPlanDigest, computeExportSignature } from "../export-signature.js";
import type { VideoDefinition } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";

const voice = defineComfyAsset({
  workflow: "voice.json",
  description: "test adapter",
  inputs: { text: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [{ kind: "graphic", id: "01", role: "hero", action: "the title card", duration: 2 }],
  },
});

const cut = (title: string, lineStart?: number) =>
  defineVideo(direction, {
    timeline: ({ graphicShot }) => ({
      shots: graphicShot("01", () => (
        <Composition>
          <div id="title">{title}</div>
          {lineStart !== undefined ? (
            <Audio src={asset("line", voice, { text: "hello" })} start={lineStart} />
          ) : null}
        </Composition>
      )),
    }),
  }) as unknown as VideoDefinition;

function makeVideo(over: Partial<VideoDefinition> = {}): VideoDefinition {
  return {
    stage: "video",
    format: { fps: 24, size: { width: 100, height: 100 } },
    shots: [{ id: "01", duration: 2, action: "i", assets: {} }],
    ...over,
  } as unknown as VideoDefinition;
}

describe("computeExportSignature", () => {
  it("is stable for an unchanged definition", () => {
    expect(computeExportSignature(cut("konte", 0))).toBe(computeExportSignature(cut("konte", 0)));
  });

  it("changes when a shot's picture changes", () => {
    expect(computeExportSignature(cut("konte"))).not.toBe(computeExportSignature(cut("nazuna")));
  });

  it("changes when a shot's audio changes", () => {
    expect(computeExportSignature(cut("konte", 0))).not.toBe(
      computeExportSignature(cut("konte", 0.5)),
    );
  });

  it("changes when a timeline soundtrack changes", () => {
    const a = makeVideo();
    const b = makeVideo({
      timelineSoundtracks: [
        {
          __soundtrackEntry: true,
          id: "bgm",
          src: { src: "__konte:reference:bgm__" },
          options: {},
        },
      ],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).not.toBe(computeExportSignature(b));
  });

  it("changes when the delivery config changes", () => {
    const a = makeVideo();
    const b = makeVideo({
      export: { delivery: { size: { width: 200, height: 200 } } },
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).not.toBe(computeExportSignature(b));
  });
});

describe("computeExportPlanDigest", () => {
  it("is stable for an unchanged definition and covers the signature", () => {
    expect(computeExportPlanDigest(cut("konte"))).toBe(computeExportPlanDigest(cut("konte")));
    expect(computeExportPlanDigest(cut("konte"))).not.toBe(computeExportPlanDigest(cut("nazuna")));
  });

  it("changes when the direction hands a shot a different length", () => {
    const a = makeVideo({
      shots: [{ id: "01", duration: 1, action: "i", assets: {} }],
    } as unknown as Partial<VideoDefinition>);
    const b = makeVideo({
      shots: [{ id: "01", duration: 1.5, action: "i", assets: {} }],
    } as unknown as Partial<VideoDefinition>);
    expect(computeExportSignature(a)).toBe(computeExportSignature(b));
    expect(computeExportPlanDigest(a)).not.toBe(computeExportPlanDigest(b));
  });
});
