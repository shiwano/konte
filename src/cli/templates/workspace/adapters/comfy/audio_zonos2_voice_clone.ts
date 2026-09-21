// source-hash: ab157c82135d081ea3de5b4b92f8a722e136853912c8dc82fdc12f42342ed82a
// source: konte / workflows/konte/audio_zonos2_voice_clone.json (hand-authored)
import { defineComfyAsset } from "konte";

export const audioZonos2VoiceClone = defineComfyAsset({
  workflow: "audio_zonos2_voice_clone.json",
  description:
    "ZONOS2 voice clone — narration from text in the voice of a reference clip; multilingual, no transcript. It reads a line, it cannot act one.",
  guide: "konte/guides/zonos2.md",
  nodes: [{ id: "zonos2-tts-comfyui-emotion" }],
  // No `models`: the loader names a repo, and its `download_if_missing` fetches the checkpoint
  // and the DAC/speaker-encoder directories as one snapshot.
  inputs: {
    // LoadAudio → Zonos2EmotionVoiceClone.reference_audio
    referenceAudio: { nodeId: "2", field: "audio", type: "audio", required: true },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    script: { nodeId: "3", field: "text", type: "spokenText", required: true },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    emotion: {
      nodeId: "3",
      field: "emotion",
      type: "string",
      default: "none",
      values: ["none", "happy", "sad", "angry", "surprised"],
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    emotionStrength: { nodeId: "3", field: "emotion_strength", type: "number", default: 1.0 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    emotionCfgScale: { nodeId: "3", field: "emotion_cfg_scale", type: "number", default: 1.0 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    emotionValence: { nodeId: "3", field: "emotion_valence", type: "number", default: 0 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    emotionArousal: { nodeId: "3", field: "emotion_arousal", type: "number", default: 0 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    cleanSpeakerBackground: {
      nodeId: "3",
      field: "clean_speaker_background",
      type: "boolean",
      default: false,
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    accurateMode: { nodeId: "3", field: "accurate_mode", type: "boolean", default: true },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    maxNewTokens: { nodeId: "3", field: "max_new_tokens", type: "number", default: 1024 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    repetitionPenalty: { nodeId: "3", field: "repetition_penalty", type: "number", default: 1.2 },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    speakingRate: {
      nodeId: "3",
      field: "speaking_rate",
      type: "string",
      default: "default",
      values: [
        "default",
        "0: 0-8",
        "1: 8-11",
        "2: 11-14",
        "3: 14-17",
        "4: 17-21",
        "5: 21-28",
        "6: 28-40",
        "7: 40+",
      ],
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    loudnessLufs: {
      nodeId: "3",
      field: "loudness_lufs",
      type: "string",
      default: "default",
      values: [
        "default",
        "0: -1000--50",
        "1: -50--45.5",
        "2: -45.5--41",
        "3: -41--36.5",
        "4: -36.5--32",
        "5: -32--27.5",
        "6: -27.5--23",
        "7: -23--18.5",
        "8: -18.5--14",
        "9: -14--9.5",
        "10: -9.5--5",
        "11: -5+",
      ],
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    leadingSilence: {
      nodeId: "3",
      field: "leading_silence",
      type: "string",
      default: "default",
      values: [
        "default",
        "0: 0-0.05",
        "1: 0.05-0.1",
        "2: 0.1-0.25",
        "3: 0.25-0.5",
        "4: 0.5-1",
        "5: 1-2",
        "6: 2-4",
        "7: 4+",
      ],
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    trailingSilence: {
      nodeId: "3",
      field: "trailing_silence",
      type: "string",
      default: "3: 0.25-0.5",
      values: [
        "default",
        "0: 0-0.05",
        "1: 0.05-0.1",
        "2: 0.1-0.25",
        "3: 0.25-0.5",
        "4: 0.5-1",
        "5: 1-2",
        "6: 2-4",
        "7: 4+",
      ],
    },
    // Zonos2EmotionVoiceClone → SaveAudioAdvanced.audio
    seed: { nodeId: "3", field: "seed", type: "seed", default: 0 },
  },
  outputs: {
    audio: { nodeId: "4", type: "audio" },
  },
  validators: (inputs) => {
    const conditioned =
      inputs.emotion !== "none" || inputs.emotionValence !== 0 || inputs.emotionArousal !== 0;

    if (conditioned && inputs.emotionStrength === 0) {
      return `"emotionStrength" is 0, which disables the very conditioning "emotion"/"emotionValence"/"emotionArousal" ask for. Raise it, or take the emotion back out.`;
    }
    if (!conditioned) {
      const inert = (["emotionStrength", "emotionCfgScale"] as const).filter(
        (name) => inputs[name] !== 1,
      );
      if (inert.length > 0) {
        const one = inert.length === 1;
        return `${inert.map((name) => `"${name}"`).join(", ")} scale${one ? "s" : ""} emotion conditioning, and nothing here asks for any — set "emotion", "emotionValence" or "emotionArousal", or leave ${one ? "it" : "them"} at 1.`;
      }
    }
    if (inputs.accurateMode === !conditioned) return;
    return conditioned
      ? `"accurateMode" has to be false while the reading is emotion-conditioned — speaker adherence flattens the emotion back out.`
      : `"accurateMode" has to be true while nothing conditions the reading — with no emotion to work against, speaker adherence is what carries the clone.`;
  },
});
