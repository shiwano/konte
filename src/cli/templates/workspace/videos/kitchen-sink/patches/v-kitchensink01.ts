import { adapters, asset, definePatch } from "konte";
import { falNanoBanana2Edit } from "konte/workspace/adapters/fal/nano-banana-2.js";

export default definePatch<"image">(({ source }) => {
  const sized = asset("sized", adapters.imageResize, { image: source, width: 1248, height: 704 });
  return asset("edited", falNanoBanana2Edit, {
    inputImage: [sized],
    prompt: "Warm the light on the table top, the rest of the frame held as it is.",
  });
});
