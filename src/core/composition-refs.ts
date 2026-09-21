import * as path from "node:path";
import { parseAssetPath } from "./address.js";
import { KonteError } from "./errors.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import {
  getRenderContext,
  type HostVisitor,
  type RenderContext,
  renderToHtml,
} from "./jsx-html.js";
import type { StateManager } from "./state/index.js";

const ASSET_PATH = /^(?:animatic|video|reference):/;

// Whether a decoded placeholder body addresses an asset a composition may consume. Not every
// `__konte:…__` does: `__konte:seed__` is a render-time token, and a user's own text (a subtitle, an
// `alt`) can spell a placeholder that parses as nothing. A `#delivery` target is rejected too — it is
// an export artifact, never authored into a composition, and its `#` would read as a URL fragment in
// the `src` a ref is staged under.
export function isAssetPath(value: string): boolean {
  if (!ASSET_PATH.test(value)) return false;
  try {
    return !parseAssetPath(value).delivery;
  } catch {
    return false;
  }
}

// Every asset a shot's composition consumes, split into picture and audio. Both the raw element tree
// and the discovery render are consulted: the raw walk sees a ref passed as a prop to a user
// component, while only the render sees one a function component pulls in from a closure
// (`function Layer() { return <Image src={animatic.shot("01").image("first")}/> }` — its element has no
// props at all). `compositionRefs` is the source of truth for the composition's dependencies, its
// input fingerprints, and the export gate, so missing one means a black layer that no gate catches.
//
// Classification is by host tag: an <audio> (or data-konte-track="sound") src is audio-only; a
// <video data-has-audio="true"> src is BOTH (the video is picture, its embedded audio is a stem
// source); every other src is picture. `pictureRefs` = compositionRefs minus the audio-only ones (so
// a ref used anywhere non-audio — including a hasAudio video — stays picture). Falls back to the raw
// walk, picture-only, on a render failure so a definition still loads — except a `KonteError`, which
// a component throws on purpose.
//
// The same pass reads the shot's `<Cutin>`: how many it renders, the assets drawn inside one, and
// which of those the shot's own picture draws as well. `cutin` is null only where the render failed.
export function partitionShotRefs(
  element: React.ReactElement,
  context: RenderContext,
  treeRefs: readonly string[],
): {
  compositionRefs: string[];
  pictureRefs: string[];
  stemRefs: string[];
  cutin: { count: number; refs: string[]; sharedRefs: string[] } | null;
} {
  const rendered = new Set<string>();
  const audioOnly = new Set<string>();
  const stem = new Set<string>();
  const cutinRefs = new Set<string>();
  const outsideRefs = new Set<string>();
  let cutinCount = 0;
  const visitor: HostVisitor = (tag, props) => {
    if (props["data-konte-cutin"] !== undefined) cutinCount++;
    const raw = props.src;
    if (typeof raw !== "string") return;
    const path = parsePlaceholder(raw);
    if (path === null || !isAssetPath(path)) return;
    rendered.add(path);
    if (getRenderContext().lane === "cutin") cutinRefs.add(path);
    else outsideRefs.add(path);
    if (tag === "audio" || props["data-konte-track"] === "sound") {
      audioOnly.add(path);
      stem.add(path);
    } else if (tag === "video" && props["data-has-audio"] === "true") {
      stem.add(path);
    }
  };

  const valid = treeRefs.filter(isAssetPath);
  try {
    renderToHtml(element, context, visitor);
  } catch (err) {
    if (err instanceof KonteError) throw err;
    return { compositionRefs: [...valid], pictureRefs: [...valid], stemRefs: [], cutin: null };
  }

  const compositionRefs = [...new Set([...valid, ...rendered])];
  return {
    compositionRefs,
    pictureRefs: compositionRefs.filter((r) => !audioOnly.has(r)),
    stemRefs: [...stem],
    cutin: {
      count: cutinCount,
      refs: [...cutinRefs],
      sharedRefs: [...cutinRefs].filter((ref) => outsideRefs.has(ref)),
    },
  };
}

interface ResolvedCompositionRef {
  address: string;
  variantId: string;
  file: string;
  isAccepted: boolean;
}

// Total by construction: `depPath` is whatever `parsePlaceholder` yielded, and a user's own text can
// shape that (a literal `__konte:video:seed__` in a subtitle spells the placeholder syntax but names
// no asset). `isAssetPath` rejects those, so the address machinery below never sees an unparseable
// path; an unresolvable ref yields null and the caller leaves the placeholder in place.
export function resolveCompositionRef(
  manager: StateManager,
  depPath: string,
  options: {
    includeStale?: boolean;
    // Live-preview only: force a specific variant for the ref's resolved address, so the
    // review UI can audition a variant the reviewer picked in the gallery (e.g. a fresh
    // soundtrack take) before it is accepted. A missing/fileless override is ignored.
    overrideByAddress?: ReadonlyMap<string, string>;
  } = {},
): ResolvedCompositionRef | null {
  if (!isAssetPath(depPath)) return null;
  const { includeStale, overrideByAddress } = options;
  // A dependency path IS its upstream address (address ≡ asset path).
  const address = depPath;
  const overrideVariantId = overrideByAddress?.get(address);
  if (overrideVariantId) {
    const variant = manager.getState().assets[address]?.variants?.[overrideVariantId];
    if (variant?.file) {
      return {
        address,
        variantId: overrideVariantId,
        file: path.resolve(manager.videoRoot, variant.file),
        isAccepted: variant.status === "accepted",
      };
    }
  }
  const resolved = manager.resolveReference(address, { includeStale });
  if (!resolved) return null;
  return {
    address,
    variantId: resolved.variantId,
    file: resolved.file,
    isAccepted: resolved.isAccepted,
  };
}

// A `__konte:<stage>:<suffix>__` placeholder that survived into rendered HTML. `asset()` swaps a
// shot's OWN assets for their resolved file the moment it runs in render mode, so whatever is left
// is a ref reaching outside the shot: an animatic panel (`animatic.shot("01").image("first")`), a
// reference asset pulled in by closure (`reference.bgm`), or a prior video shot's asset
// (`shot("01").video("motion")`), or its own animatic's stem (`animatic.stem`). Each must be
// substituted before the HTML reaches a browser or ffmpeg. The character class is the alphabet
// `makePlaceholder`/`makeAddressPlaceholder` can mint — an asset path's `.`, `:` and reserved-name
// `#` separators plus identifier characters. `#delivery` matches here but `isAssetPath` rejects it,
// so it is left in place like any other unresolvable ref.
const ASSET_PLACEHOLDER = /__konte:((?:reference|animatic|video):[A-Za-z0-9_.#-]+)__/g;

// Substitute every surviving asset placeholder via `resolve`. A ref `resolve` cannot map is left
// as-is, so it renders visibly broken rather than being silently dropped.
export function substituteAssetPlaceholders(
  html: string,
  resolve: (assetPath: string) => string | null,
): string {
  return html.replace(ASSET_PLACEHOLDER, (whole, assetPath: string) => resolve(assetPath) ?? whole);
}
