import { KonteError } from "../../errors.js";
import { getRenderContext, renderInContext } from "../../jsx-html.js";
import type { Cutin as CutinDeclaration } from "../direction.js";

// The direction's declaration of the frame this component draws, under the same name: a DSL import
// of `Cutin` reaches both.
export type Cutin = CutinDeclaration;

export type CutinCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CutinProps = {
  /** The corner the frame sits in. Defaults to `"bottom-right"`. */
  at?: CutinCorner;
  /** The frame's width as a fraction of the canvas width, `0 < size ≤ 1`; it keeps the canvas aspect. Defaults to 0.3. */
  size?: number;
  /** The gap to the two edges it sits against, as a fraction of the canvas width, `0 ≤ inset < 0.5`. Defaults to 0.03. */
  inset?: number;
  className?: string;
  style?: React.ComponentPropsWithoutRef<"div">["style"];
  children?: React.ReactNode;
};

/**
 * A second camera frame laid over the shot for its whole duration — the wipe the direction declares
 * as the shot's `cutin`. On the animatic its children are that frame's `<Panel>`s, on the video its
 * `<Video>`; a keyframe inside it keys the cutin. Where it sits and how
 * big it is are this component's alone: the direction declares only who the frame holds.
 */
export function Cutin({
  at = "bottom-right",
  size = 0.3,
  inset = 0.03,
  className,
  style,
  children,
}: CutinProps): React.ReactElement {
  const { shotId, width, lane } = getRenderContext();
  if (lane === "cutin") {
    throw new KonteError(
      "CUTIN_UNDECLARED",
      `Shot "${shotId}" nests a <Cutin> inside another. A shot declares one cutin frame.`,
    );
  }
  if (!(size > 0 && size <= 1)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Shot "${shotId}" <Cutin size={${size}}> must be a fraction of the canvas width in (0, 1].`,
    );
  }
  if (!(inset >= 0 && inset < 0.5)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Shot "${shotId}" <Cutin inset={${inset}}> must be a fraction of the canvas width in [0, 0.5).`,
    );
  }
  const [vertical, horizontal] = at.split("-") as ["top" | "bottom", "left" | "right"];
  const gap = `${Math.round(inset * width)}px`;
  const html = renderInContext(children, { lane: "cutin" });
  return (
    <div
      data-konte-cutin=""
      className={className}
      style={{
        position: "absolute",
        [vertical]: gap,
        [horizontal]: gap,
        width: `${size * 100}%`,
        height: `${size * 100}%`,
        overflow: "hidden",
        zIndex: 1,
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
