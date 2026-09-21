// The working canvas is derived, never authored. An author states what the piece ships at
// (`size.delivery`) and how much generation they are willing to pay for (`size.megapixels`); konte
// resolves the two into the resolution every stage generates and reviews at.

export type CanvasSize = { width: number; height: number };

// The size grid every sampler lands on. 32 is a multiple of the 8- and 16-pixel grids the smaller
// models use, so one number covers all three: a base on it is never raised by an adapter's `grid`
// (see AdapterInputGrid), which would otherwise return media larger than the canvas and let the
// composition's `object-fit: cover` crop back the frame the model composed for.
export const CANVAS_GRID = 32;

// The exact size a budget asks for at a delivery's aspect, before the grid. The derivation rounds
// this to the grid; a caller checks it to see whether the budget can be held at that aspect at all.
export function idealSize(budget: CanvasBudget): CanvasSize {
  const aspect = budget.delivery.width / budget.delivery.height;
  const area = budget.megapixels * 1_000_000;
  const width = Math.sqrt(area * aspect);
  return { width, height: width / aspect };
}

function floorToGrid(value: number): number {
  return Math.max(CANVAS_GRID, Math.floor(value / CANVAS_GRID) * CANVAS_GRID);
}

function ceilToGrid(value: number): number {
  return Math.max(CANVAS_GRID, Math.ceil(value / CANVAS_GRID) * CANVAS_GRID);
}

// The four grid points bracketing the ideal size, ranked by aspect error first and area error
// second. The bracket is what holds the budget: ranking is a tiebreak WITHIN it, never a search over
// the grid — a global aspect-first search would return the nearest exact-aspect size at any area
// (1024×576 for every 16:9 budget, since it is exactly 16:9). Inside the bracket, aspect outranks
// area because the delivered picture is cropped back to the delivery aspect (see `core/delivery.ts`),
// so an axis off by a grid step costs picture while an area off by a few percent costs only time.
//
// Aspect error is measured on the log of the ratio rather than on the ratio's distance from 1, so a
// candidate that is too wide and one too narrow by the same factor score the same. That is what makes
// the derivation transpose: a portrait delivery resolves to exactly the landscape one's canvas,
// turned. A relative error scores the two sides differently and can pick a canvas that is not the
// transpose.
//
// `megapixels` is a target, not a cap; the overshoot is bounded by one grid step per axis.
function deriveV1(megapixels: number, delivery: CanvasSize): CanvasSize {
  const aspect = delivery.width / delivery.height;
  const area = megapixels * 1_000_000;
  const idealWidth = Math.sqrt(area * aspect);
  const idealHeight = idealWidth / aspect;

  const widths = [floorToGrid(idealWidth), ceilToGrid(idealWidth)];
  const heights = [floorToGrid(idealHeight), ceilToGrid(idealHeight)];

  let best: CanvasSize | null = null;
  let bestScore: [number, number] | null = null;
  for (const width of widths) {
    for (const height of heights) {
      const score: [number, number] = [
        Math.abs(Math.log(width / height / aspect)),
        Math.abs((width * height) / area - 1),
      ];
      // Ties break on the smaller width, then the smaller height: the derivation is hashed, so it
      // must not depend on candidate order.
      const better =
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] &&
          (score[1] < bestScore[1] ||
            (score[1] === bestScore[1] &&
              (width < best!.width || (width === best!.width && height < best!.height)))));
      if (better) {
        best = { width, height };
        bestScore = score;
      }
    }
  }
  return best!;
}

/**
 * The authored half of `policy.format.size`: what ships, and what it may cost to get there.
 */
export type CanvasBudget = {
  megapixels: number;
  delivery: CanvasSize;
};

// A piece's base size — and so every variant baked against it — is a function of this code, and it
// feeds the definition hash. Changing the rule moves the canvas of every existing piece and stales
// what was built on it, so a future change needs a version pinned in the direction to opt into; the
// same goes for the delivery cover/crop (`core/delivery.ts`), which sizes a composition's frame.
export function deriveCanvasBase(budget: CanvasBudget): CanvasSize {
  return deriveV1(budget.megapixels, budget.delivery);
}

/**
 * A reference sheet's shape: a character is portrait, a location is a master, and a prop is squared,
 * as is anything outside the rosters.
 */
export type ReferenceShape = "portrait" | "square" | "master";

// A standing figure fills 2:3 with little margin left to pay for; the ratio lands exactly on the
// grid wherever the long edge is a multiple of 96.
const PORTRAIT_SHORT_EDGE = 2 / 3;

// A location sheet is the master a plate is cut out of, so it is sized for the crop rather than for
// the frame: twice the canvas on its long edge, so the tightest window still carries texture, at
// 2:1 — the widest a place can be drawn without the sampler doubling what is in it. The long edge
// stays the canvas', so a turned piece gets a turned master and a vertical window keeps the same
// headroom a horizontal one has.
const MASTER_LONG_EDGE_SCALE = 2;
const MASTER_ASPECT = 2;

function roundToGrid(value: number): number {
  return Math.max(CANVAS_GRID, Math.round(value / CANVAS_GRID) * CANVAS_GRID);
}

// A reference is sized off the canvas' LONG edge, so it holds up wherever a shot crops into it.
// Like the base it feeds the definition hash, so changing the rule stales every sheet built on it.
export function deriveReferenceSize(base: CanvasSize, shape: ReferenceShape): CanvasSize {
  const long = Math.max(base.width, base.height);
  if (shape === "portrait") return { width: roundToGrid(long * PORTRAIT_SHORT_EDGE), height: long };
  if (shape === "square") return { width: long, height: long };
  const masterLong = roundToGrid(long * MASTER_LONG_EDGE_SCALE);
  const masterShort = roundToGrid(masterLong / MASTER_ASPECT);
  return base.height > base.width
    ? { width: masterShort, height: masterLong }
    : { width: masterLong, height: masterShort };
}
