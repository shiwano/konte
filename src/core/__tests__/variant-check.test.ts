import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writeHeardSpeech } from "../speech-hearing.js";
import { variantDir } from "../variant-dir.js";
import { checkVariant } from "../variant-check.js";
import type { KonteState, VariantState } from "../types/index.js";

const variant = (media: VariantState["media"]): VariantState => ({
  status: "none",
  file: "take.mp4",
  definitionHash: null,
  outputHash: "bytes",
  createdAt: "2026-01-01T00:00:00.000Z",
  inputFingerprints: {},
  metadata: {},
  media,
});

const check = (media: VariantState["media"], lines: string[]) =>
  checkVariant({
    videoRoot: "/nonexistent",
    state: { assets: {} } as unknown as KonteState,
    address: "video:shot.01.motion",
    variantId: "v-a",
    variant: variant(media),
    lines,
    lang: "en",
  });

const video = (audio: Extract<VariantState["media"], { kind: "video" }>["audio"]) => ({
  kind: "video" as const,
  width: 640,
  height: 360,
  fps: 24,
  durationSec: 2,
  audio,
});

describe("checkVariant", () => {
  it("finds a silent audio take, line or none", () => {
    const silent = {
      kind: "audio" as const,
      durationSec: 2,
      channels: 1,
      sampleRate: 48000,
      silent: true,
    };
    expect(check(silent, [])).toEqual([{ type: "silent", detail: "is silent" }]);
  });

  it("finds a video owing a line that is silent or has no track", () => {
    expect(check(video({ channels: 1, sampleRate: 48000, silent: true }), ["Hello"])).toEqual([
      { type: "silent", detail: "is silent" },
    ]);
    expect(check(video(null), ["Hello"])).toEqual([
      { type: "silent", detail: "has no audio track" },
    ]);
  });

  it("passes a video owing no line, whatever its track", () => {
    expect(check(video({ channels: 1, sampleRate: 48000, silent: true }), [])).toEqual([]);
    expect(check(video(null), [])).toEqual([]);
  });

  it("passes a take whose silence was never measured", () => {
    expect(
      check({ kind: "audio", durationSec: 2, channels: 1, sampleRate: 48000 }, ["Hello"]),
    ).toEqual([]);
  });

  it("reads a patched take's line off the chain step its file belongs to", async () => {
    const videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-variant-check-"));
    const step = { address: "animatic:patch.v-src.trimmed", variantId: "v-step" };
    const file = path.join(variantDir("", step.address, step.variantId), "out.wav");
    await writeHeardSpeech(videoRoot, step.address, step.variantId, {
      outputHash: "bytes",
      heard: [{ text: " she should fill the sky", startSec: 0.1 }],
    });
    const patched = {
      ...variant({ kind: "audio", durationSec: 2, channels: 1, sampleRate: 48000 }),
      file,
    };
    const state = {
      assets: { [step.address]: { variants: { [step.variantId]: { ...patched } } } },
    } as unknown as KonteState;

    expect(
      checkVariant({
        videoRoot,
        state,
        address: "animatic:shot.35.line",
        variantId: "v-patched",
        variant: patched,
        lines: ["Bigger! She should fill the sky!"],
        lang: "en",
      }),
    ).toEqual([
      {
        type: "line-misheard",
        detail: 'heard "she should fill the sky" — drops the opening "Bigger!"',
      },
    ]);
    await fs.rm(videoRoot, { recursive: true, force: true });
  });
});
