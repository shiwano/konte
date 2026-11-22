// The runtime drives the composition clock from a captured gsap timeline. A shot
// without an <Animate> registers none, leaving the runtime's currentTime undefined
// and every timed element hidden. Guarantee a capturable timeline spanning the shot
// duration without clobbering a user-provided one.
export function injectBaseTimeline(
  compositionHtml: string,
  shotId: string,
  duration: number,
): string {
  const baseTag =
    `<script>(function(){var g=window.gsap;if(!g||!g.timeline)return;` +
    `window.__timelines=window.__timelines||{};var key=${JSON.stringify(`shot-${shotId}`)};` +
    `var tl=window.__timelines[key];if(!tl||typeof tl.set!=="function"){tl=g.timeline({paused:true});` +
    `window.__timelines[key]=tl;}tl.set({},{},${duration});})()</script>`;
  const bodyCloseIdx = compositionHtml.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return `${compositionHtml.slice(0, bodyCloseIdx)}${baseTag}\n${compositionHtml.slice(bodyCloseIdx)}`;
  }
  return compositionHtml + baseTag;
}
