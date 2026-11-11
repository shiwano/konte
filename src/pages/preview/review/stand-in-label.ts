import type { StandInCause } from "../types.js";

export function standInLabel(cause: StandInCause | null): string {
  switch (cause) {
    case "generating":
      return "Animatic: generating";
    case "stale":
      return "Animatic: out of date";
    default:
      return "Animatic: not made yet";
  }
}

export function standInTitle(cause: StandInCause | null): string {
  const lead = "Standing in with the board: ";
  const tail = ", so there is nothing here to sign off";
  switch (cause) {
    case "generating":
      return `${lead}this shot's picture is still being generated${tail}`;
    case "stale":
      return `${lead}this shot's picture was made from inputs that have since changed and waits to be remade${tail}`;
    default:
      return `${lead}this shot's picture is not made yet${tail}`;
  }
}
