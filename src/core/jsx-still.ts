import * as path from "node:path";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { captureHtmlToImage } from "./still-capture.js";

/** The inputs a `jsxImage` definition carries (see `dsl/adapters/jsx-image.tsx`). */
export interface JsxStillInputs {
  html: string;
  width: number;
  height: number;
  refs?: readonly string[];
}

export function asJsxStillInputs(inputs: Record<string, unknown>): JsxStillInputs {
  return {
    html: inputs.html as string,
    width: inputs.width as number,
    height: inputs.height as number,
    refs: (inputs.refs ?? []) as readonly string[],
  };
}

// Intrinsically sized so a tree that lets the image size itself still lays out; a tree that sizes
// the box gets the tile scaled into it.
const TILE = { width: 640, height: 360 };

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Base64 rather than a percent-encoded body: the placeholder is substituted into an HTML attribute
// whose quoting this must not depend on.
function placeholderTile(address: string): string {
  const { width, height } = TILE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#26262b"/>` +
    `<rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="none" stroke="#6b6b78" stroke-width="4" stroke-dasharray="18 12"/>` +
    `<text x="${width / 2}" y="${height / 2 - 14}" fill="#8f8f9c" font-family="monospace" font-size="24" text-anchor="middle">unresolved</text>` +
    `<text x="${width / 2}" y="${height / 2 + 26}" fill="#e4e4ee" font-family="monospace" font-size="22" text-anchor="middle">${escapeXml(address)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

/**
 * Render a `jsxImage` definition's HTML to a PNG.
 *
 * The refs it consumes are buried inside that HTML, so each one's placeholder is rewritten to a
 * workspace-relative name and the file linked in under it. Names are indexed rather than derived
 * from the address: an address carries `:` and `.`, which a URL path segment and the file server's
 * own lookup would each read their own way.
 *
 * Longest placeholder first. An asset name may contain underscores, so one placeholder can be a
 * PREFIX of another (`__konte:video:shot.01.a__` of `__konte:video:shot.01.a__b__`) — replacing the
 * short one first would eat the long one's opening and strand the rest as literal text. A prefix is
 * the only overlap possible: `__konte:` contains a `:`, which no asset name may.
 *
 * `resolveRef` returns the absolute file behind a placeholder, or `null` to stand a labelled tile in
 * for it. Generation never passes `null`; the tile is a read surface's affordance only.
 */
export async function renderJsxStill(opts: {
  inputs: JsxStillInputs;
  outputFile: string;
  videoRoot: string;
  resolveRef: (placeholder: string) => Promise<string | null>;
}): Promise<{ unresolved: string[] }> {
  let html = opts.inputs.html;
  const assetFiles: Record<string, string> = {};
  const unresolved: string[] = [];
  const refs = [...(opts.inputs.refs ?? [])]
    .filter((placeholder) => parsePlaceholder(placeholder) !== null)
    .sort((a, b) => b.length - a.length);

  for (const [index, placeholder] of refs.entries()) {
    const file = await opts.resolveRef(placeholder);
    if (file === null) {
      const address = parsePlaceholder(placeholder)!;
      unresolved.push(address);
      html = html.split(placeholder).join(placeholderTile(address));
      continue;
    }
    const name = `asset-${index}${path.extname(file)}`;
    assetFiles[name] = file;
    html = html.split(placeholder).join(name);
  }

  await captureHtmlToImage({
    html,
    assetFiles,
    outputFile: opts.outputFile,
    videoRoot: opts.videoRoot,
    size: { width: opts.inputs.width, height: opts.inputs.height },
    format: "png",
  });

  return { unresolved };
}
