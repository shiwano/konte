import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorkflow, parameterizeWorkflow } from "../../comfyui/workflow.js";
import { getAssetEntryByAddress } from "../../core/address.js";
import type { ComfyAssetDefinition } from "../../core/types/index.js";
import { loadDefinitionForAddress } from "../load-definition.js";
import { ctx, initWorkspace, run, useTempWorkspace } from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 30000 });

useTempWorkspace();

// The shipped adapter's `audioStem` declaration and the workflow it names have to agree on node ids.
// These takes exercise the audio guide and the `<Audio N>` ordinals, so their bodies are minimal
// and the shape around them is the real one.
const six = (body: string) => ({
  subjectDefinitions: ["<Picture 1> is the first frame of [Shot 1]."],
  summary: { tasks: ["keyframe completion"], text: "The take opens on the passed frame." },
  retentionAnalysis: [
    "<Picture 1> ([Shot 1] first frame): fully_preserved - the take opens on this exact frame.",
  ],
  detailedDescription: { style: "2D-animated.", shots: [body] },
  overallSoundscape: "A quiet room.",
  nonDiegeticMusic: "N/A",
});

const REFERENCE_TSX = (
  synced: string,
  prompt = six("<Picture 1> speaks the line."),
) => `import { defineReference, asset, adapters } from "konte";
// @ts-expect-error konte's fixture adapter is runtime-only, outside the workspace's generated types.
import { internalTestPlate } from "konte";
import { videoMinimaxH3R2v } from "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const studio = asset("studio", internalTestPlate, { width: 512, height: 512, color: "#f3eefb" });
  const bare = asset("bare", videoMinimaxH3R2v, {
    image1: character,
    prompt: ${JSON.stringify(six("<Picture 1> turns to the window."))},
  });
  const synced = asset("synced", videoMinimaxH3R2v, {
    image1: character,
    ${synced}
    prompt: ${JSON.stringify(prompt)},
  });
  return { character, bgm, studio, bare, synced };
});
`;

// A clip and its own soundtrack. `video1` carries no track, so the first `<Audio N>` is `video2`'s.
const CLIP_TSX = (slots: string) => `import { defineReference, asset, adapters } from "konte";
import { videoMinimaxH3R2v } from "konte/workspace/adapters/comfy/video_minimax_h3_r2v.js";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const clip = asset("clip", adapters.videoFile, { path: "assets/files/clip.mp4" });
  const gapped = asset("gapped", videoMinimaxH3R2v, {
    image1: character,
    ${slots}
    prompt: ${JSON.stringify(
      six(
        "<Video 1> and <Video 2> are the source clips, <Audio 1> the track of the second and <Audio 2> the bed.",
      ),
    )},
  });
  return { character, bgm, clip, gapped };
});
`;

async function inspectDefinition(videoRoot: string, name: string): Promise<ComfyAssetDefinition> {
  const address = `reference:${name}`;
  const definition = await loadDefinitionForAddress(videoRoot, address);
  return getAssetEntryByAddress(definition, address) as ComfyAssetDefinition;
}

describe("shipped MiniMax H3 R2V adapter", () => {
  it("prunes the audio guide by the adapter's own declaration, and keeps it when audioStem is passed", async () => {
    const { workspace, video } = await initWorkspace(path.join(ctx.dir, "p"));
    await fs.writeFile(path.join(video, "reference.tsx"), REFERENCE_TSX("audioStem: bgm,"));
    const workflow = await loadWorkflow(
      path.join(workspace, "adapters", "comfy", "video_minimax_h3_r2v.json"),
    );

    const bare = await inspectDefinition(video, "bare");
    expect(bare.prunedNodes).toEqual(
      expect.arrayContaining(["163", "164", "165", "166", "167", "168"]),
    );
    expect(bare.prunedPassThroughs).toEqual({
      "164": "positive",
      "166": "positive",
      "168": "positive",
    });
    expect(bare.inputs["163.audio"]).toBeUndefined();
    const bareGraph = parameterizeWorkflow(
      workflow,
      bare.inputs,
      1,
      undefined,
      bare.prunedNodes,
      bare.prunedPassThroughs,
    );
    expect(bareGraph["164"]).toBeUndefined();
    expect(bareGraph["126"]!.inputs.conditioning).toEqual(["136", 0]);

    const synced = await inspectDefinition(video, "synced");
    expect(synced.prunedNodes).not.toEqual(expect.arrayContaining(["163"]));
    expect(synced.prunedNodes).not.toEqual(expect.arrayContaining(["164"]));
    expect(synced.prunedPassThroughs).toEqual({ "166": "positive", "168": "positive" });
    expect(synced.inputs["163.audio"]).toBe("__konte:reference:bgm__");
    const syncedGraph = parameterizeWorkflow(
      workflow,
      synced.inputs,
      1,
      undefined,
      synced.prunedNodes,
      synced.prunedPassThroughs,
    );
    expect(syncedGraph["164"]!.class_type).toBe("MiniMaxH3AddGuide");
    expect(syncedGraph["126"]!.inputs.conditioning).toEqual(["164", 0]);
  });

  // The guide takes no `<Audio N>` label: tagging one over it names a reference that is not there.
  it("gives the guide no <Audio N> ordinal, unlike a reference audio", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "p"));
    const prompt = six("<Picture 1> speaks the line in <Audio 1>.");
    await fs.writeFile(path.join(video, "reference.tsx"), REFERENCE_TSX("audioStem: bgm,", prompt));
    await expect(run(["inspect", "reference:synced"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("The prompt names <Audio 1>, but no <Audio N> slot is wired"),
    });

    // A second workspace: a rewrite within the same second would be served from the transpiler cache.
    const other = await initWorkspace(path.join(ctx.dir, "q"));
    await fs.writeFile(
      path.join(other.video, "reference.tsx"),
      REFERENCE_TSX("audio1: bgm,", prompt),
    );
    const synced = await inspectDefinition(other.video, "synced");
    expect(synced.inputs["160.audio"]).toBe("__konte:reference:bgm__");
  });

  // The `<Audio N>` group is exhaustive: a passed reference the prose never names is one the
  // take carries and nothing describes.
  it("refuses a reference audio no <Audio N> reaches", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "r"));
    await fs.writeFile(path.join(video, "reference.tsx"), REFERENCE_TSX("audio1: bgm,"));
    await expect(run(["inspect", "reference:synced"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("no <Audio N> in the prompt reaches"),
    });
  });

  it("takes a clip's soundtrack without the clip below it having one", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "s"));
    await fs.writeFile(path.join(video, "assets", "files", "clip.mp4"), "not a real clip");
    await fs.writeFile(
      path.join(video, "reference.tsx"),
      CLIP_TSX("video1: clip,\n    video2: clip,\n    video2Audio: clip,\n    audio1: bgm,"),
    );

    const gapped = await inspectDefinition(video, "gapped");
    expect(gapped.inputs["170.audio"]).toBe("__konte:reference:clip__");
    expect(gapped.inputs["169.audio"]).toBeUndefined();
    expect(gapped.prunedNodes).toEqual(expect.arrayContaining(["169", "171"]));
  });

  it("refuses a soundtrack whose clip is not passed", async () => {
    const { video } = await initWorkspace(path.join(ctx.dir, "t"));
    await fs.writeFile(path.join(video, "assets", "files", "clip.mp4"), "not a real clip");
    await fs.writeFile(
      path.join(video, "reference.tsx"),
      CLIP_TSX("video1: clip,\n    video2Audio: clip,\n    audio1: bgm,"),
    );

    await expect(run(["inspect", "reference:gapped"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining('"video2Audio" is set'),
    });
  });
});
