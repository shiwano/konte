import { isConsumableAddress } from "./composition-refs.js";
import {
  compositionDefinitionHash,
  overlayDefinitionHash,
  overlayFingerprintRefs,
} from "./composition-resource.js";
import { makeAddressPlaceholder, parsePlaceholder } from "./dsl/shot-context.js";
import type { VideoDefinition } from "./types/index.js";

/**
 * The video with its thumbnail frame's definition moving with what the frame shows: the picture of
 * the shot it is cut from and the overlay, whose subtitled lines' takes it reads too.
 */
export function withThumbnailFrameHashes(video: VideoDefinition): VideoDefinition {
  const frame = video.thumbnail?.frame;
  if (!frame) return video;
  const drawn = (frame.asset.inputs.refs as string[]).map((ref) => parsePlaceholder(ref) ?? ref);
  const refs = [...new Set([...drawn, ...overlayFingerprintRefs(video)])].filter(
    isConsumableAddress,
  );
  const inputs = {
    ...frame.asset.inputs,
    picture: compositionDefinitionHash(video, frame.shotId),
    overlay: video.overlay ? overlayDefinitionHash(video) : null,
    refs: refs.map(makeAddressPlaceholder),
  };
  return {
    ...video,
    thumbnail: { ...video.thumbnail!, frame: { ...frame, asset: { ...frame.asset, inputs } } },
  };
}
