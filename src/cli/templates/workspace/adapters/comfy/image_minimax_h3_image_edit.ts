// source-hash: 6c09d9d0887500daaf584a3e099d155ed6465dedede2bd688c5f0f1f6750dc2d
// source: github.com/Comfy-Org/workflow_templates / templates/image_minimax_h3_image_edit.json (MIT License)
import { defineComfyAsset, promptReferenceTags } from "konte";

type Relation =
  | "fully preserved"
  | { partially: string }
  | { transfers: string }
  | { weakly: string };

type Subject = { definition: string; relation: Relation };

const SUBJECT = /<Subject (\d+)>/g;
const PICTURE = /<Picture \d+>/;

const subjectLabel = (subject: Subject, index: number): string => {
  const labels = [...subject.definition.matchAll(SUBJECT)].map((m) => Number(m[1]));
  if (labels.length !== 1 || labels[0] !== index + 1) {
    throw new Error(
      `subjects[${index}].definition names ${labels.length === 0 ? "no <Subject N>" : labels.map((n) => `<Subject ${n}>`).join(", ")} — it defines <Subject ${index + 1}> alone`,
    );
  }
  if (!PICTURE.test(subject.definition)) {
    throw new Error(`subjects[${index}].definition names no <Picture N> it comes from`);
  }
  return `<Subject ${index + 1}>`;
};

const relationText = (label: string, relation: Relation): string => {
  if (relation === "fully preserved") return `${label} is fully preserved.`;
  if ("partially" in relation) return `${label} is partially preserved; ${relation.partially}`;
  if ("transfers" in relation) return `${label} supplies ${relation.transfers}`;
  return `${label} serves as a weak reference for ${relation.weakly}`;
};

export const imageMinimaxH3ImageEdit = defineComfyAsset({
  workflow: "image_minimax_h3_image_edit.json",
  description:
    "MiniMax H3 Image — a still edited from image1 with up to eight more reference images, drawn at 4MP or more; a plate, a plate cut from its parent's, or a view of a location, never a sheet. A shot's keyframes are imageMinimaxH3R2i's.",
  allowedIn: ["reference", "view", "plate", "timeline", "thumbnail", "patch"],
  guide: "konte/guides/minimax-h3-image.md",
  models: [
    {
      filename: "minimax_h3_image_pruned_int8_convrot.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors",
    },
    {
      filename: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
    {
      filename: "minimax_h3_image_vae_fp16.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/vae/minimax_h3_image_vae_fp16.safetensors",
    },
  ],
  inputs: {
    // LoadImage → MiniMaxH3ImageConditioning.images.image_1
    image1: {
      nodeId: "45",
      field: "image",
      type: "image",
      required: true,
      description: "the picture edited — the plate, or the take's previous frame",
    },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_2
    image2: { nodeId: "63", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_3
    image3: { nodeId: "64", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_4
    image4: { nodeId: "65", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_5
    image5: { nodeId: "66", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_6
    image6: { nodeId: "67", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_7
    image7: { nodeId: "68", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_8
    image8: { nodeId: "69", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_9
    image9: { nodeId: "70", field: "image", type: "image" },
    // MiniMaxH3ImageConditioning → ConditioningZeroOut.conditioning, KSampler.positive, KSampler.latent_image
    prompt: {
      nodeId: "32",
      field: "prompt",
      type: "prompt",
      required: true,
      structure: {
        join: " ",
        fields: {
          references: {
            required: true,
            description:
              "subjects: one { definition, relation } per <Subject N>, numbered from 1; target: the overview after `The target image`",
            render: (r: { subjects: readonly [Subject, ...Subject[]]; target: string }) => {
              const labels = r.subjects.map(subjectLabel);
              return [
                ...r.subjects.map((s) => s.definition),
                `The target image ${r.target}`,
                ...r.subjects.map((s, i) => relationText(labels[i]!, s.relation)),
              ].join(" ");
            },
          },
          details: {
            required: true,
            description: "what changes and what is new, nothing a fully preserved subject keeps",
            render: (text: string) => text,
          },
          style: { render: (text: string) => text },
        },
      },
    },
    // MiniMaxH3ImageConditioning → ConditioningZeroOut.conditioning, KSampler.positive, KSampler.latent_image
    width: { nodeId: "32", field: "width", type: "width", default: 2048, grid: { step: 32 } },
    // MiniMaxH3ImageConditioning → ConditioningZeroOut.conditioning, KSampler.positive, KSampler.latent_image
    height: { nodeId: "32", field: "height", type: "height", default: 2048, grid: { step: 32 } },
    // KSampler → VAEDecode.samples
    seed: { nodeId: "38", field: "seed", type: "seed", default: 0 },
    // UNETLoader → KSampler.model
    unetName: {
      nodeId: "29",
      field: "unet_name",
      type: "string",
      default: "minimax_h3_image_pruned_int8_convrot.safetensors",
    },
    // CLIPLoader → MiniMaxH3ImageConditioning.clip
    clipName: {
      nodeId: "30",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
    // VAELoader → MiniMaxH3ImageConditioning.vae, VAEDecode.vae
    vaeName: {
      nodeId: "31",
      field: "vae_name",
      type: "string",
      default: "minimax_h3_image_vae_fp16.safetensors",
    },
  },
  outputs: {
    image: { nodeId: "9", type: "image" },
  },
  minPixels: 4_000_000,
  promptExemptions: [/\bno other (?:lettering|text)\b/i],
  validators: promptReferenceTags({
    tags: {
      Picture: [
        "image1",
        "image2",
        "image3",
        "image4",
        "image5",
        "image6",
        "image7",
        "image8",
        "image9",
      ],
      Video: [],
      Audio: [],
    },
  }),
});
