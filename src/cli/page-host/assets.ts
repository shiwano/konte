import { UI_ICON_PNG_BASE64 } from "../../core/generated/ui-assets.js";
import { NativeResponse } from "./http.js";

interface UiBundle {
  html: string;
  js: string;
  css: string;
}

interface StaticAsset {
  content: string | Blob;
  contentType: string;
}

const ICON_PNG = new Blob([Buffer.from(UI_ICON_PNG_BASE64, "base64")], { type: "image/png" });

/**
 * Every path other than the bundle, the shared icon and `extra` falls through to the HTML, so the
 * SPA owns its own routing.
 */
export function createAssetHandler(
  bundle: UiBundle,
  extra: Record<string, StaticAsset> = {},
): (pathname: string) => Response {
  const assets: Record<string, StaticAsset> = {
    "/index.js": { content: bundle.js, contentType: "text/javascript" },
    "/index.css": { content: bundle.css, contentType: "text/css" },
    "/icon.png": { content: ICON_PNG, contentType: "image/png" },
    ...extra,
  };

  return (pathname: string): Response => {
    const asset = assets[pathname];
    if (asset) {
      return new NativeResponse(asset.content, { headers: { "Content-Type": asset.contentType } });
    }
    return new NativeResponse(bundle.html, { headers: { "Content-Type": "text/html" } });
  };
}
