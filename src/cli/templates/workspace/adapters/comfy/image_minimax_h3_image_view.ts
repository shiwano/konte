// source-hash: 6c09d9d0887500daaf584a3e099d155ed6465dedede2bd688c5f0f1f6750dc2d
// source: github.com/Comfy-Org/workflow_templates / templates/image_minimax_h3_image_edit.json (MIT License)
import { defineComfyAsset, promptReferenceTags } from "konte";

type View = {
  room: string;
  camera: string;
  layout: string;
  look: string;
  coarseFill?: string;
};

const viewText = ({ room, camera, layout, look, coarseFill }: View): string =>
  (coarseFill === undefined
    ? [
        `The ${room} in <Picture 1> is <Subject 1>.`,
        `The target image shows the same ${room} from a new camera position.`,
        camera,
        layout,
        `<Subject 1> supplies ${look}, carried onto the new camera position.`,
      ]
    : [
        `The rough 3D render of the ${room} in <Picture 1> is <Subject 1>.`,
        `The ${room} in <Picture 2> is <Subject 2>.`,
        "The target image shows <Subject 1> finished as a painted frame from the same camera position, every piece of furniture where it lies in <Subject 1>, and its flat grey area drawn as the rest of the room.",
        layout,
        camera,
        `<Subject 1> is partially preserved; its camera position, its composition and the place and colour of each piece of furniture remain, while its smeared, stretched surfaces are redrawn clean and each piece of furniture, flattened and warped in <Subject 1>, is redrawn whole and solid as the same piece in <Subject 2>, turned to face the new camera position and its flat grey area is drawn as ${coarseFill}.`,
        `<Subject 2> supplies ${look}, carried onto the camera position of <Subject 1>.`,
      ]
  ).join(" ");

export const imageMinimaxH3ImageView = defineComfyAsset({
  workflow: "image_minimax_h3_image_view.json",
  description:
    "MiniMax H3 Image — a location's view image, painted over its coarse (the master drawn from the view's camera) in the master's look, or drawn from the master alone for `back`.",
  guide: "konte/guides/minimax-h3-image-view.md",
  allowedIn: ["view"],
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
      description: "the view's coarse, `coarse.<locationId>.<view>`; for `back`, the master",
    },
    // LoadImage → MiniMaxH3ImageConditioning.images.image_2
    image2: {
      nodeId: "63",
      field: "image",
      type: "image",
      description:
        "the master, `reference.<locationId>`, beside a coarse, with `prompt.view.coarseFill`",
    },
    // MiniMaxH3ImageConditioning → ConditioningZeroOut.conditioning, KSampler.positive, KSampler.latent_image
    prompt: {
      nodeId: "32",
      field: "prompt",
      type: "prompt",
      required: true,
      structure: {
        join: " ",
        fields: {
          view: {
            required: true,
            description:
              "room: the place's noun; camera: where the camera stands and faces; layout: where each landmark lies, in place words; look: what the master carries over; coarseFill: what the coarse's grey becomes, with `image2`",
            render: viewText,
          },
          details: { render: (text: string) => text },
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
  validators: promptReferenceTags({
    tags: { Picture: ["image1", "image2"], Video: [], Audio: [] },
  }),
});
