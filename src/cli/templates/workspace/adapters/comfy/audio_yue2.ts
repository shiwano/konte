// source-hash: 7234d9624b2a474dceec801c84abf3279463c729554a3a76f2dacc2ebee999e7
// source: github.com/Comfy-Org/workflow_templates / templates/audio_yue2_text2music.json (MIT License)
import { defineComfyAsset } from "konte";

export const audioYue2 = defineComfyAsset({
  workflow: "audio_yue2.json",
  description:
    "YuE2 — a sung song, or an instrumental with lyrics left empty, from a style line and tagged lyrics, planned as a score and played at the given bpm; length follows the lyrics. The first pick for a song or a bed.",
  guide: "konte/guides/yue2.md",
  models: [
    {
      filename: "yue2_3b_int8_convrot.safetensors",
      type: "checkpoint",
      url: "https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors",
    },
  ],
  inputs: {
    // PrimitiveStringMultiline → YuE2GenerateABC.style, YuE2GenerateMusic.style
    style: { nodeId: "54", field: "value", type: "prompt", default: "" },
    // PrimitiveStringMultiline → YuE2GenerateABC.lyrics, YuE2GenerateMusic.lyrics
    lyrics: { nodeId: "55", field: "value", type: "spokenText", default: "" },
    // PrimitiveInt → StringFormat.values.a
    bpm: {
      nodeId: "56",
      field: "value",
      type: "number",
      default: 120,
      description:
        "Quarter-note tempo, a whole number, written into the planned score's Q: line, which the take plays at.",
    },
    // YuE2GenerateABC → RegexReplace.string
    mode: {
      nodeId: "42",
      field: "mode",
      type: "string",
      default: "full",
      values: ["full", "melody"],
      also: [{ nodeId: "46", field: "mode" }],
      description:
        "full plans melody and chords; melody plans the melody alone and leaves the accompaniment freer.",
    },
    // YuE2GenerateMusic → ConditioningZeroOut.conditioning, KSampler.positive, EmptyYuE2LatentAudio.seconds
    maxDuration: {
      nodeId: "46",
      field: "max_duration",
      type: "seconds",
      default: 360,
      description:
        "Ceiling in seconds: a longer song is cut there mid-phrase; follows the shot's duration where one is in scope.",
    },
    // SeedNode → YuE2GenerateABC.seed, YuE2GenerateMusic.seed, KSampler.seed
    seed: { nodeId: "53", field: "seed", type: "seed", default: 0 },
    // CheckpointLoaderSimple → YuE2GenerateABC.clip, YuE2GenerateMusic.clip, KSampler.model, VAEDecodeAudio.vae
    ckptName: {
      nodeId: "41",
      field: "ckpt_name",
      type: "string",
      default: "yue2_3b_int8_convrot.safetensors",
    },
  },
  outputs: {
    audio: { nodeId: "10", type: "audio" },
  },
});
