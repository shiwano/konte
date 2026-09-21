import type { FileAssetDefinition } from "../../types/index.js";
import type { MediaKind } from "../builders.js";
import type { AssetAdapter } from "../adapter.js";

const FILES_PREFIX = "assets/files/";

export type FileAdapterInputs = {
  path: `assets/files/${string}`;
};

function createFileAdapter<T extends MediaKind>(mediaType: T): AssetAdapter<FileAdapterInputs, T> {
  return {
    type: mediaType,
    meta: {
      backend: "file",
      mediaType,
      description: `Reference an existing ${mediaType} under assets/files/ — no generation.`,
      ref: "file",
      inputs: { path: { type: "string", required: true } },
    },
    createDefinition(inputs: FileAdapterInputs): FileAssetDefinition {
      if (!inputs.path.startsWith(FILES_PREFIX)) {
        throw new Error(`file path must start with "${FILES_PREFIX}", got "${inputs.path}"`);
      }
      return {
        kind: "file",
        path: inputs.path,
        type: mediaType,
        deterministic: true,
      };
    },
  };
}

export const imageFile = createFileAdapter("image");
export const videoFile = createFileAdapter("video");
export const audioFile = createFileAdapter("audio");
