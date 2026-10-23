/// <reference path="../md.d.ts" />
import tailwindBrowser from "@tailwindcss/browser" with { type: "text" };
import drawSvgPlugin from "gsap/dist/DrawSVGPlugin.min.js" with { type: "text" };
import gsap from "gsap/dist/gsap.min.js" with { type: "text" };
import splitText from "gsap/dist/SplitText.min.js" with { type: "text" };

// Tailwind is the release konte checks classes against (see tailwind-classes.ts); DrawSVGPlugin
// registers itself on load; SplitText is a class `<Animate>`'s `split` calls.
export const COMPOSITION_SCRIPTS: readonly string[] = [
  gsap,
  splitText,
  drawSvgPlugin,
  tailwindBrowser,
];
