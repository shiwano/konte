import type { Stage } from "../../../core/address.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type {
  AnimaticDefinition,
  Handoff,
  ReferenceDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import type { ReportOutcome } from "./review-outcome.js";

// What one review session holds, shared by every stage's state and submit handlers.
export interface ReviewContext {
  videoRoot: string;
  // The stage this session reviews. A submit naming another is refused: the shot ids coincide across
  // the reels, so a page and a server that disagree would sign off takes nobody saw.
  stage: Stage;
  handoff: Handoff | null;
  direction: Direction | null;
  // The shared pool. A reel plays `reference:` addresses too (a bed, a sheet a panel stands on), and
  // this is the only definition that answers for their declaration.
  reference: ReferenceDefinition | null;
  // The board. On the animatic stage it IS the reel; on the video stage it is the upstream, standing
  // in for a shot whose picture is not made yet.
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
  reportOutcome?: ReportOutcome;
}

// The video downstream of the board, when the board is the reel under review.
export function downstreamVideoOf(ctx: ReviewContext): VideoDefinition | null {
  return ctx.stage === "animatic" ? ctx.video : null;
}
