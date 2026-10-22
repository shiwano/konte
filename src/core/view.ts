// The way a camera faces in its location. `front` is the location master's (`reference:<id>`),
// `back` its reverse, `side` square to the `front` axis — one side only: a place whose two side walls
// differ is two locations — and `top` straight down.
export const VIEWS = ["front", "back", "side", "top"] as const;

export type View = (typeof VIEWS)[number];

// The views with an image of their own. `front` is the master itself.
export type ImagedView = Exclude<View, "front">;

export const IMAGED_VIEWS = VIEWS.filter((v): v is ImagedView => v !== "front");

export function isView(value: unknown): value is View {
  return (VIEWS as readonly unknown[]).includes(value);
}

export function isImagedView(value: unknown): value is ImagedView {
  return (IMAGED_VIEWS as readonly unknown[]).includes(value);
}

// A location's view image is filed in the reference pool as `view.<locationId>.<view>`. A name holds
// no `.`, so no author's asset can take this form.
export const VIEW_NAME_BODY = `view\\.([a-zA-Z0-9_-]+)\\.(${IMAGED_VIEWS.join("|")})`;
const VIEW_NAME_PATTERN = new RegExp(`^${VIEW_NAME_BODY}$`);

export function viewAssetName(locationId: string, view: ImagedView): string {
  return `view.${locationId}.${view}`;
}

// The location and view a reference asset name or address is filed under, or null for any other.
export function parseViewName(
  nameOrAddress: string,
): { location: string; view: ImagedView } | null {
  const name = nameOrAddress.startsWith("reference:")
    ? nameOrAddress.slice("reference:".length)
    : nameOrAddress;
  const m = VIEW_NAME_PATTERN.exec(name);
  return m ? { location: m[1]!, view: m[2] as ImagedView } : null;
}
