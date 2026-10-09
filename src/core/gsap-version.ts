const GSAP_CDN = "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist";

// DrawSVGPlugin registers itself on load; SplitText is a class `<Animate>`'s `split` calls.
export const GSAP_SCRIPT_SRCS = [
  `${GSAP_CDN}/gsap.min.js`,
  `${GSAP_CDN}/SplitText.min.js`,
  `${GSAP_CDN}/DrawSVGPlugin.min.js`,
] as const;
