import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAssetEntryByAddress } from "../../core/address.js";
import type { ComfyAssetDefinition } from "../../core/types/index.js";
import { loadDefinitionForAddress } from "../load-definition.js";
import { ctx, doctorChecks, initWorkspace, run, useTempWorkspace } from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 60000 });

useTempWorkspace();

const REFERENCE_TSX = (body: string) => `import { defineReference, asset, adapters } from "konte";
import { imageMinimaxH3R2i } from "konte/workspace/adapters/comfy/image_minimax_h3_r2i.js";
import { videoMinimaxH3R2v } from "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js";
import { audioMinimaxH3R2a } from "konte/workspace/adapters/comfy/audio_minimax_h3_r2a.js";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
${body}
});
`;

const ASSETS = `
  const still = asset("still", imageMinimaxH3R2i, {
    image1: character,
    image2: character,
    frameIndex: 20,
    prompt: {
      subjectDefinitions: ["<Subject 1> is the creator in <Picture 1>.", "<Picture 2> is the frame this take cuts from."],
      summary: { tasks: ["reference generation", "keyframe completion"], text: "She looks up." },
      retentionAnalysis: [
        "<Subject 1> (appears in [Shot 2]): fully_preserved - her face and dress.",
        "<Picture 2> ([Shot 1] frame): fully_preserved - the frame it cuts from.",
      ],
      detailedDescription: {
        style: "2D-animated.",
        shots: ["The frame of <Picture 2>.", { at: 0.2, text: "the camera cuts in to her face." }],
      },
    },
  });
  const motion = asset("motion", videoMinimaxH3R2v, {
    image1: character,
    prompt: {
      subjectDefinitions: ["<Picture 1> is the first frame of [Shot 1]."],
      summary: { tasks: ["keyframe completion"], text: "She turns." },
      retentionAnalysis: ["<Picture 1> ([Shot 1] first frame): fully_preserved - the opening frame."],
      detailedDescription: {
        style: "2D-animated.",
        shots: ["She turns.", { at: 1.5, text: "the camera cuts to the window." }, { at: 3.25, text: "back to her." }],
      },
      overallSoundscape: "A quiet room.",
      nonDiegeticMusic: "N/A",
    },
  });
  const cast = asset("cast", audioMinimaxH3R2a, {
    prompt: {
      integratedMultimodalDescription: {
        style: "live-action.",
        shots: ["A close, dry room; she says, <d>[English] Hello there.</d>"],
      },
      overallSoundscape: "A faint room tone.",
      nonDiegeticMusic: "N/A",
    },
  });
  const line = asset("line", audioMinimaxH3R2a, {
    audio1: bgm,
    prompt: {
      subjectDefinitions: ["<Audio 1> is the voice-timbre reference for <Subject 1> (S1).", "<Subject 1> is the creator."],
      summary: { tasks: ["reference generation", "audio reference"], text: "She greets the room." },
      retentionAnalysis: ["<Audio 1>: weak_reference - her timbre.", "<Subject 1>: fully_preserved - her voice."],
      detailedDescription: {
        style: "live-action.",
        shots: ["She says, <d>[English] Hello there, it has been a long and quiet morning in the studio.</d>"],
      },
      overallSoundscape: "A faint room tone.",
      nonDiegeticMusic: "N/A",
    },
  });
  return { character, bgm, still, motion, cast, line };`;

async function promptOf(videoRoot: string, name: string): Promise<ComfyAssetDefinition> {
  const address = `reference:${name}`;
  const definition = await loadDefinitionForAddress(videoRoot, address);
  return getAssetEntryByAddress(definition, address) as ComfyAssetDefinition;
}

describe("shipped MiniMax H3 prompts", () => {
  it("assembles each adapter's sections as the model reads them", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "p"));
    await fs.writeFile(path.join(video, "reference.tsx"), REFERENCE_TSX(ASSETS));

    expect((await promptOf(video, "still")).inputs["10.prompt"]).toBe(
      [
        "subject_definitions: <Subject 1> is the creator in <Picture 1>.\n<Picture 2> is the frame this take cuts from.",
        "summary: [reference generation + keyframe completion] She looks up.",
        "retention_analysis: <Subject 1> (appears in [Shot 2]): fully_preserved - her face and dress.\n<Picture 2> ([Shot 1] frame): fully_preserved - the frame it cuts from.",
        "detailed_description: 2D-animated. [Shot 1] The frame of <Picture 2>. [Shot 2] At 00:00.200, the camera cuts in to her face.",
        "overall_soundscape: N/A",
        "non_diegetic_music: N/A",
      ].join("\n\n"),
    );

    expect((await promptOf(video, "motion")).inputs["136.prompt"]).toBe(
      [
        "subject_definitions: <Picture 1> is the first frame of [Shot 1].",
        "summary: [keyframe completion] She turns.",
        "retention_analysis: <Picture 1> ([Shot 1] first frame): fully_preserved - the opening frame.",
        "detailed_description: 2D-animated. [Shot 1] She turns. [Shot 2] At 00:01.500, the camera cuts to the window. [Shot 3] At 00:03.250, back to her.",
        "overall_soundscape: A quiet room.",
        "non_diegetic_music: N/A",
      ].join("\n\n"),
    );

    // With no reference wired R2A takes three fields, and its style follows `[Shot 1]`.
    expect((await promptOf(video, "cast")).inputs["10.prompt"]).toBe(
      [
        "integrated_multimodal_description: [Shot 1] live-action. A close, dry room; she says, <d>[English] Hello there.</d>",
        "overall_soundscape: A faint room tone.",
        "non_diegetic_music: N/A",
      ].join("\n\n"),
    );
    expect((await promptOf(video, "line")).inputs["10.prompt"]).toMatch(
      /^subject_definitions: [\s\S]*\n\ndetailed_description: live-action\. \[Shot 1\] She says,/,
    );
  });

  it("derives R2A's length from the <d> words of the assembled prompt", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "q"));
    await fs.writeFile(path.join(video, "reference.tsx"), REFERENCE_TSX(ASSETS));

    const short = (await promptOf(video, "cast")).inputs["10.length"] as number;
    const long = (await promptOf(video, "line")).inputs["10.length"] as number;
    expect(short).not.toBe(120);
    expect((short - 5) % 17).toBe(0);
    expect(long).toBeGreaterThan(short);
  });

  it("refuses R2A's reference shape with no reference wired", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "r"));
    await fs.writeFile(
      path.join(video, "reference.tsx"),
      REFERENCE_TSX(`
  const line = asset("line", audioMinimaxH3R2a, {
    prompt: {
      subjectDefinitions: ["<Subject 1> is the creator."],
      summary: { tasks: ["reference generation"], text: "She greets the room." },
      retentionAnalysis: ["<Subject 1>: fully_preserved - her voice."],
      detailedDescription: { style: "live-action.", shots: ["She says, <d>[English] Hello.</d>"] },
      overallSoundscape: "N/A",
      nonDiegeticMusic: "N/A",
    },
  });
  return { character, bgm, line };`),
    );
    await expect(run(["inspect", "reference:line"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("while no reference is wired"),
    });
  });

  // Each refused call is marked `@ts-expect-error`, so the check fails if any of them type-checks.
  it("refuses by type what each adapter's grammar does not take", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "s"));
    const ok = `subjectDefinitions: [], retentionAnalysis: []`;
    await fs.writeFile(
      path.join(video, "reference.tsx"),
      REFERENCE_TSX(`
  // @ts-expect-error R2I keeps one cut at most
  asset("a", imageMinimaxH3R2i, { image1: character, prompt: { ${ok}, summary: { tasks: ["reference generation"], text: "x" }, detailedDescription: { style: "s", shots: ["a", { at: 1, text: "b" }, { at: 2, text: "c" }] } } });
  // @ts-expect-error R2I takes no audio task
  asset("b", imageMinimaxH3R2i, { image1: character, prompt: { ${ok}, summary: { tasks: ["audio reuse"], text: "x" }, detailedDescription: { style: "s", shots: ["a"] } } });
  // @ts-expect-error R2I writes its own sound sections
  asset("c", imageMinimaxH3R2i, { image1: character, prompt: { ${ok}, summary: { tasks: ["reference generation"], text: "x" }, detailedDescription: { style: "s", shots: ["a"] }, overallSoundscape: "N/A" } });
  // @ts-expect-error [Shot 1] carries no cut time
  asset("d", videoMinimaxH3R2v, { image1: character, prompt: { ${ok}, summary: { tasks: ["keyframe completion"], text: "x" }, detailedDescription: { style: "s", shots: [{ at: 0, text: "a" }] }, overallSoundscape: "N/A", nonDiegeticMusic: "N/A" } });
  // @ts-expect-error R2V writes its sound sections out
  asset("e", videoMinimaxH3R2v, { image1: character, prompt: { ${ok}, summary: { tasks: ["keyframe completion"], text: "x" }, detailedDescription: { style: "s", shots: ["a"] } } });
  // @ts-expect-error R2A takes no clip task
  asset("f", audioMinimaxH3R2a, { audio1: bgm, prompt: { ${ok}, summary: { tasks: ["video editing"], text: "x" }, detailedDescription: { style: "s", shots: ["a"] }, overallSoundscape: "N/A", nonDiegeticMusic: "N/A" } });
  // @ts-expect-error a structured prompt takes no string
  asset("g", videoMinimaxH3R2v, { image1: character, prompt: "summary: [keyframe completion] x" });
  return { character, bgm };`),
    );

    const typeCheck = (await doctorChecks(video)).find((check) => check.name === "type check");
    expect(typeCheck?.details.join("\n") ?? "").toBe("");
    expect(typeCheck?.status).toBe("PASS");
  });
});
