import { KonteError } from "../../errors.js";
import { getRenderContext } from "../../jsx-html.js";

declare const GSAP_TARGETS: unique symbol;

export interface GsapTargets {
  readonly [GSAP_TARGETS]: true;
}

type GsapTarget = string | GsapTargets;

export interface GsapTimeline {
  to(target: GsapTarget, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  from(target: GsapTarget, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  fromTo(
    target: GsapTarget,
    fromVars: Record<string, unknown>,
    toVars: Record<string, unknown>,
    position?: number | string,
  ): GsapTimeline;
  set(target: GsapTarget, vars: Record<string, unknown>, position?: number | string): GsapTimeline;
  add(child: unknown, position?: number | string): GsapTimeline;
  addLabel(label: string, position?: number | string): GsapTimeline;
  call(fn: () => void, position?: number | string): GsapTimeline;
}

export interface GsapSplitOptions {
  type: "chars" | "words" | "words,chars";
  mask?: "chars" | "words";
}

export interface GsapSplit {
  chars: GsapTargets;
  words: GsapTargets;
}

export interface AnimateContext {
  timeline: GsapTimeline;
  split: (selector: string, options: GsapSplitOptions) => GsapSplit;
}

// Escaping these instead of refusing would change what a tagged template (`String.raw`) and a regex
// literal mean, so a source carrying one is refused. Either alone is harmless — "<!--" only opens the
// tokenizer's escaped state, where the end tag still closes — so neither is rejected on its own.
const SCRIPT_END_TAG = /<\/script[\s/>]/i;
const SCRIPT_START_TAG = /<script[\s/>]/i;

function hostileSequence(source: string): string | null {
  if (SCRIPT_END_TAG.test(source)) return "</script";
  if (source.includes("<!--") && SCRIPT_START_TAG.test(source)) return "<!-- … <script";
  return null;
}

// Two ways the emitted <script> is lost whole, the timeline registration with it — the shot then
// comes out a silent static frame. `new Function` compiles without running.
function assertEmbeddable(shotId: string, source: string): void {
  const hostile = hostileSequence(source);
  if (hostile) {
    throw new KonteError(
      "ANIMATE_SCRIPT_INVALID",
      `Shot "${shotId}"'s <Animate> script source contains "${hostile}", which stops the <script> ` +
        `element it is embedded in from closing. Build the string from parts — "<" + "/script>".`,
    );
  }
  try {
    // Sloppy mode, matching the emitted script: "use strict" here would reject sources the browser
    // accepts.
    new Function(`return (${source});`);
  } catch {
    throw new KonteError(
      "ANIMATE_SCRIPT_INVALID",
      `Shot "${shotId}"'s <Animate> script cannot be embedded: its source is not a standalone ` +
        `expression. A method shorthand — { script({ timeline }) { … } } — serializes to one, and so ` +
        `does a bound or native function. Pass an arrow or a function expression.`,
    );
  }
}

// The only channel a failure reaches a human by: `injectBaseTimeline` hands the capture a timeline
// whether or not the script ran, and HyperFrames swallows page logs.
//
// The host is resolved at throw time, not from the script's own position: in a full-video render
// HyperFrames lifts every composition script out of the mounted fragment onto `document.body`. A shot
// roots at its `[data-composition-id]` host, which HyperFrames' scoped `querySelector` resolves to
// itself; a standalone render carries that attribute on a <head> <meta>, so the tag is checked and
// `#stage` used instead.
function errorOverlayJs(shotId: string): string {
  const key = JSON.stringify(`shot-${shotId}`);
  const hostSelector = JSON.stringify(`[data-composition-id="shot-${shotId}"]`);
  return `var host=document.querySelector(${hostSelector});if(host&&host.tagName==="META")host=null;host=host||document.getElementById("stage")||document.body;if(host){var box=document.createElement("div");box.setAttribute("data-konte-animate-error",${key});box.style.cssText="position:absolute;left:0;right:0;bottom:0;z-index:2147483647;background:#b00020;color:#fff;font:600 14px/1.4 ui-monospace,monospace;padding:10px 14px;white-space:pre-wrap;word-break:break-word;";box.textContent="konte: <Animate> script failed in "+${key}+"\\n"+msg;host.appendChild(box);}`;
}

const ANIMATE_ERRORS_GLOBAL = "__konteAnimateErrors";

export function compositionAnimates(html: string): boolean {
  return html.includes(`window.${ANIMATE_ERRORS_GLOBAL}`);
}

export function Animate({
  script,
}: {
  script?: (ctx: AnimateContext) => void;
}): React.ReactElement {
  const { shotId } = getRenderContext();

  const source = script?.toString();
  if (source !== undefined) assertEmbeddable(shotId, source);
  const scriptBody = source === undefined ? "" : `(${source})({ timeline: tl, split: split });`;

  // `split` resolves its selector through `document`, which a full-video render scopes to the shot;
  // SplitText given the string would query the whole page, every shot's duplicate ids included.
  // The shot's timeline registers before the script runs: a throw costs only the tweens after it, and
  // the capture's readiness handshake still resolves.
  const key = JSON.stringify(`shot-${shotId}`);
  const scriptText = `(function () {
window.__timelines = window.__timelines || {};
var shotTl = window.__timelines[${key}];
if (!shotTl) {
  shotTl = gsap.timeline({ paused: true });
  window.__timelines[${key}] = shotTl;
}
var tl = gsap.timeline();
shotTl.add(tl, 0);
var split = function (selector, options) {
  var result = SplitText.create(document.querySelectorAll(selector), options);
  return { chars: result.chars, words: result.words };
};
try {
${scriptBody}
} catch (err) {
  var msg = (err && err.message) ? err.message : String(err);
  window.${ANIMATE_ERRORS_GLOBAL} = window.${ANIMATE_ERRORS_GLOBAL} || [];
  window.${ANIMATE_ERRORS_GLOBAL}.push({ shotId: ${JSON.stringify(shotId)}, message: msg });
  console.error("[konte] <Animate> script threw in shot " + ${JSON.stringify(shotId)} + ": " + msg +
    " — every tween after the throw is missing. The script is serialized and run in the browser, so it cannot reference anything outside itself.");
  ${errorOverlayJs(shotId)}
}
})();`;

  return <script>{scriptText}</script>;
}
