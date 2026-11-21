import type { AsideShot, GraphicShot, Shot } from "./direction.js";

export function isAsideShot(shot: Shot): shot is AsideShot {
  return shot.kind === "aside";
}

export function isGraphicShot(shot: Shot): shot is GraphicShot {
  return shot.kind === "graphic";
}
