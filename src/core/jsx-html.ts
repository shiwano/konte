import type { PanelDefinition, PanelLane, Typography } from "./types/definition.js";

export interface RenderContext {
  shotId: string;
  width: number;
  height: number;
  duration: number;
  // ANIMATIC ONLY: the shot's resolved keyframe windows, so a `<Panel>` can read the slot it holds
  // — which runs to the next panel's start, and so is a property of the shot, not of the panel.
  // Absent on the pass that produces them (`defineAnimatic`'s own) and on any video render.
  panels?: readonly PanelDefinition[];
  // ANIMATIC ONLY: the same for the keyframes inside the shot's `<Cutin>`.
  cutinPanels?: readonly PanelDefinition[];
  // Which camera frame the elements rendering now belong to. `<Cutin>` sets it for its children;
  // absent is the shot's own picture.
  lane?: PanelLane;
  // The document language and font stack `Composition` renders its <head> from.
  typography: Typography;
  // Each cue source's levelling gain, keyed by the src as it appears in this render (see
  // `cueBySrc`); `<Audio>` folds it into `data-volume`. Absent on a discovery/harvest render, which
  // is what keeps the levelling out of a composition's identity.
  levelGains?: Readonly<Record<string, number>>;
  // Each sfx cue source's lead-in (see `cueLeadIn`), keyed the same way; `<Audio>` with no declared
  // `mediaStart` emits it as `data-media-start`. Absent on a discovery/harvest render, like the gains.
  leadIns?: Readonly<Record<string, number>>;
  // When true, `Composition` emits a bare children fragment (no <html>/<head>/#stage)
  // for embedding as a nested composition's <template> body. Set only by the
  // multi-shot preview assembly (`buildFullCompositionHtml`).
  nested?: boolean;
  // When true, the document is captured as one frame at t=0 and drives no timeline. `Composition`
  // marks its host `data-no-timeline`: the capture otherwise waits out its full 45s readiness
  // timeout for a `window.__timelines` registration that never comes. Set only by `jsxImage`.
  still?: boolean;
  // EXPORT DELIVERY ONLY: the frame actually captured, cut from the centre of the `width`×`height`
  // composition above (see `deliveryCoverSize`). Absent everywhere else, where the captured frame IS
  // the composition.
  crop?: { width: number; height: number };
}

// The typography of a render whose HTML is thrown away — only what the host visitor harvests on the
// way through is kept (the audio placements of a shot).
export const HARVEST_TYPOGRAPHY: Typography = { lang: "en" };

let currentContext: RenderContext | null = null;

/** Whether a `renderToHtml` is running — a function component's body runs only then. */
export function isRendering(): boolean {
  return currentContext !== null;
}

export function getRenderContext(): RenderContext {
  if (!currentContext) {
    throw new Error("getRenderContext() called outside of renderToHtml()");
  }
  return currentContext;
}

// Called for every host (DOM) element as it is rendered, with its fully-resolved
// props — after function components have run, so computed values (data-* defaults,
// resolved src URLs) are present. Lets a caller harvest structured data in the same
// pass instead of re-parsing the HTML string. Receives native prop values, not
// HTML-escaped strings.
export type HostVisitor = (tag: string, props: Record<string, unknown>) => void;

let currentVisitor: HostVisitor | null = null;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["style", "script"]);

const ATTR_MAP: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  playsInline: "playsinline",
  autoPlay: "autoplay",
  crossOrigin: "crossorigin",
  tabIndex: "tabindex",
  readOnly: "readonly",
  noValidate: "novalidate",
  formNoValidate: "formnovalidate",
  autoFocus: "autofocus",
  autoComplete: "autocomplete",
  ...Object.fromEntries(
    [
      "alignmentBaseline",
      "baselineShift",
      "clipPath",
      "clipRule",
      "colorInterpolation",
      "colorInterpolationFilters",
      "dominantBaseline",
      "fillOpacity",
      "fillRule",
      "floodColor",
      "floodOpacity",
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontWeight",
      "imageRendering",
      "letterSpacing",
      "lightingColor",
      "markerEnd",
      "markerMid",
      "markerStart",
      "paintOrder",
      "shapeRendering",
      "stopColor",
      "stopOpacity",
      "strokeDasharray",
      "strokeDashoffset",
      "strokeLinecap",
      "strokeLinejoin",
      "strokeMiterlimit",
      "strokeOpacity",
      "strokeWidth",
      "textAnchor",
      "textDecoration",
      "textRendering",
      "transformOrigin",
      "vectorEffect",
      "wordSpacing",
      "writingMode",
    ].map((name) => [name, hyphenateStyleName(name)]),
  ),
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// React-style style props are objects, not strings. Properties whose numeric value
// is a unitless quantity (so a bare number must NOT get a "px" suffix).
const UNITLESS_STYLE_PROPS = new Set([
  "animationIterationCount",
  "aspectRatio",
  "borderImageOutset",
  "borderImageSlice",
  "borderImageWidth",
  "boxFlex",
  "boxFlexGroup",
  "boxOrdinalGroup",
  "columnCount",
  "columns",
  "flex",
  "flexGrow",
  "flexShrink",
  "flexOrder",
  "gridArea",
  "gridRow",
  "gridRowEnd",
  "gridRowSpan",
  "gridRowStart",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnSpan",
  "gridColumnStart",
  "fontWeight",
  "lineClamp",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
]);

function hyphenateStyleName(name: string): string {
  if (name.startsWith("--")) return name; // CSS custom property — verbatim
  return name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^ms-/, "-ms-");
}

// Serialize a React-style style object to a CSS declaration string, matching React:
// camelCase → kebab-case, and a bare non-zero number gets a "px" suffix unless the
// property is unitless. null/undefined/false declarations are dropped.
function styleToCss(style: Record<string, unknown>): string {
  const decls: string[] = [];
  for (const [prop, raw] of Object.entries(style)) {
    if (raw === null || raw === undefined || raw === false) continue;
    const value =
      typeof raw === "number" && raw !== 0 && !UNITLESS_STYLE_PROPS.has(prop)
        ? `${raw}px`
        : String(raw);
    decls.push(`${hyphenateStyleName(prop)}:${value}`);
  }
  return decls.join(";");
}

function renderAttr(key: string, value: unknown): string {
  if (key === "children" || key === "dangerouslySetInnerHTML" || key === "key" || key === "ref") {
    return "";
  }

  // Event handlers / refs (`onClick`, etc.) are meaningless in static HTML — drop them
  // rather than serialize the function's source text into an attribute (React SSR does the same).
  if (typeof value === "function") {
    return "";
  }

  const attrName = ATTR_MAP[key] ?? key;

  if (key === "style" && typeof value === "object" && value !== null) {
    const css = styleToCss(value as Record<string, unknown>);
    return css ? ` style="${escapeHtml(css)}"` : "";
  }

  if (typeof value === "boolean") {
    return value ? ` ${attrName}` : "";
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return ` ${attrName}="${value}"`;
  }

  return ` ${attrName}="${escapeHtml(String(value))}"`;
}

function renderChildren(children: unknown, isRawText: boolean): string {
  if (children === null || children === undefined || typeof children === "boolean") {
    return "";
  }

  if (typeof children === "string") {
    return isRawText ? children : escapeHtml(children);
  }

  if (typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map((child) => renderChildren(child, isRawText)).join("");
  }

  if (typeof children === "object" && children !== null && "type" in children) {
    return renderElement(children as JSXElement);
  }

  return "";
}

interface JSXElement {
  type: string | symbol | ((props: Record<string, unknown>) => JSXElement);
  props: Record<string, unknown>;
}

function renderElement(element: unknown): string {
  if (element === null || element === undefined || typeof element === "boolean") {
    return "";
  }

  if (typeof element === "string") {
    return escapeHtml(element);
  }

  if (typeof element === "number") {
    return String(element);
  }

  if (Array.isArray(element)) {
    return element.map(renderElement).join("");
  }

  if (typeof element !== "object" || !("type" in (element as object))) {
    return "";
  }

  const { type, props } = element as JSXElement;

  if (typeof type === "function") {
    const result = type(props);
    return renderElement(result);
  }

  if (typeof type === "symbol") {
    return renderChildren(props.children, false);
  }

  const tag = type as string;
  currentVisitor?.(tag, props);
  const isRaw = RAW_TEXT_ELEMENTS.has(tag);
  const isVoid = VOID_ELEMENTS.has(tag);

  let attrs = "";
  for (const [key, value] of Object.entries(props)) {
    attrs += renderAttr(key, value);
  }

  if (isVoid) {
    return `<${tag}${attrs} />`;
  }

  let innerHTML = "";
  if (props.dangerouslySetInnerHTML) {
    const dih = props.dangerouslySetInnerHTML as { __html: string };
    innerHTML = dih.__html;
  } else {
    innerHTML = renderChildren(props.children, isRaw);
  }

  return `<${tag}${attrs}>${innerHTML}</${tag}>`;
}

// Render children to HTML under a narrowed context, inside a render already running. A component's
// returned element renders only after the component has returned, so a component that must change
// what its CHILDREN read of the context renders them itself. The host visitor keeps running, so a
// harvest sees every host element inside as it would outside.
export function renderInContext(children: React.ReactNode, patch: Partial<RenderContext>): string {
  const outer = getRenderContext();
  currentContext = { ...outer, ...patch };
  try {
    return renderChildren(children, false);
  } finally {
    currentContext = outer;
  }
}

export function renderToHtml(
  element: React.ReactElement,
  context: RenderContext,
  visitor?: HostVisitor,
): string {
  currentContext = context;
  currentVisitor = visitor ?? null;
  try {
    const html = renderElement(element);
    const isRootHtml =
      typeof (element as unknown as JSXElement).type === "string" &&
      (element as unknown as JSXElement).type === "html";
    if (isRootHtml) {
      return `<!doctype html>\n${html}`;
    }
    return html;
  } finally {
    currentContext = null;
    currentVisitor = null;
  }
}
