import { makeMediaAsset } from "./dsl/builders.js";
import { Composition } from "./dsl/composition/composition.js";
import { Video } from "./dsl/composition/video.js";

// A shot without a shotFn has no composition; both the ffmpeg renderer and the final
// video fall back to displaying its single resolved asset full-frame (render-video.ts).
// Mirror that here so such a shot shows its asset in the preview instead of a black
// frame. The clip spans the whole shot via data-start/data-duration, which the runtime
// reveals against the composition clock.
export function buildFallbackComposition(
  url: string,
  mediaType: "video" | "image",
  duration: number,
): React.ReactElement {
  if (mediaType === "image") {
    return (
      <Composition>
        <img className="konte-clip" alt="" src={url} data-start={0} data-duration={duration} />
      </Composition>
    );
  }
  return (
    <Composition>
      <Video src={makeMediaAsset<"video">(url)} duration={duration} />
    </Composition>
  );
}
