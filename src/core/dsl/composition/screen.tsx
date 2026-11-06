import { KonteError } from "../../errors.js";
import { getRenderContext, renderInContext } from "../../jsx-html.js";

/** A point as fractions of the canvas: `[x, y]`, `[0, 0]` the top-left corner, `[1, 1]` the bottom-right. */
export type ScreenPoint = readonly [x: number, y: number];

export type ScreenProps = {
  /** The surface's corners in the frame — top-left, top-right, bottom-right, bottom-left of what it shows — as canvas fractions. */
  corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  /** The width in px of the box its children lay out in. Defaults to the mean length of the top and bottom edges. */
  width?: number;
  /** The height in px of that box. Defaults to the mean length of the left and right edges. */
  height?: number;
  className?: string;
  style?: React.ComponentPropsWithoutRef<"div">["style"];
  children?: React.ReactNode;
};

type Px = readonly [number, number];

/**
 * A flat surface in the frame seen at an angle — a monitor, a phone, a sign. Its children lay out
 * in an upright `width`×`height` box, which is warped so the box's corners land on `corners`.
 */
export function Screen({
  corners,
  width,
  height,
  className,
  style,
  children,
}: ScreenProps): React.ReactElement {
  const { shotId, width: canvasWidth, height: canvasHeight } = getRenderContext();
  if (
    corners.length !== 4 ||
    !corners.every((p) => p.length === 2 && p.every((v) => Number.isFinite(v)))
  ) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Shot "${shotId}" <Screen corners> takes four [x, y] points as canvas fractions.`,
    );
  }
  const px = corners.map(([x, y]) => [x * canvasWidth, y * canvasHeight] as const) as [
    Px,
    Px,
    Px,
    Px,
  ];
  if (!isConvexClockwise(px)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Shot "${shotId}" <Screen corners> must run top-left, top-right, bottom-right, bottom-left ` +
        `around a convex quadrilateral, got ${JSON.stringify(corners)}.`,
    );
  }
  const [tl, tr, br, bl] = px;
  const boxWidth = width ?? Math.round((distance(tl, tr) + distance(bl, br)) / 2);
  const boxHeight = height ?? Math.round((distance(tl, bl) + distance(tr, br)) / 2);
  for (const [name, value] of [
    ["width", boxWidth],
    ["height", boxHeight],
  ] as const) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `Shot "${shotId}" <Screen ${name}={${value}}> must be a positive number of px.`,
      );
    }
  }
  const html = renderInContext(children, { inScreen: true });
  return (
    <div
      data-konte-screen=""
      className={className}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: `${boxWidth}px`,
        height: `${boxHeight}px`,
        overflow: "hidden",
        transformOrigin: "0 0",
        transform: cornerPin(boxWidth, boxHeight, px),
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function distance([ax, ay]: Px, [bx, by]: Px): number {
  return Math.hypot(bx - ax, by - ay);
}

// Clockwise on screen (y down).
function isConvexClockwise(points: readonly [Px, Px, Px, Px]): boolean {
  return points.every((a, i) => {
    const b = points[(i + 1) % 4]!;
    const c = points[(i + 2) % 4]!;
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0;
  });
}

// The projective map taking the box (0,0) (w,0) (w,h) (0,h) onto the four corners, as a CSS matrix3d
// (column-major) applied about the box's top-left.
function cornerPin(w: number, h: number, [p0, p1, p2, p3]: readonly [Px, Px, Px, Px]): string {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const k = (dx1 * dy3 - dx3 * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + k * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + k * y3;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, x0, y0, 0, 1];
  return `matrix3d(${m.map((v) => Number(v.toFixed(9))).join(",")})`;
}
