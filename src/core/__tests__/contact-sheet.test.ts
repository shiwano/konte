import { describe, expect, it } from "vitest";
import {
  cellFilters,
  DEFAULT_MAX_CELLS,
  escapeFilterPath,
  MAX_CELLS_LIMIT,
  maxCellsForWidth,
  paginateCells,
  paginateGroupedCells,
  planContactSheetLayout,
  sheetAspect,
} from "../contact-sheet.js";

const SHEET_MAX_EDGE = 1568;
const SHEET_MAX_PIXELS = 1_150_000;

describe("planContactSheetLayout", () => {
  it("keeps every sheet inside the bounds a vision model reads without downscaling", () => {
    for (let cap = 1; cap <= MAX_CELLS_LIMIT; cap++) {
      for (const count of [1, Math.ceil(cap / 2), cap]) {
        const layout = planContactSheetLayout(cap, count);
        expect(Math.max(layout.sheetWidth, layout.sheetHeight)).toBeLessThanOrEqual(SHEET_MAX_EDGE);
        expect(layout.sheetWidth * layout.sheetHeight).toBeLessThanOrEqual(SHEET_MAX_PIXELS);
      }
    }
  });

  it("rejects a cap beyond the range where both bounds can be held", () => {
    expect(() => planContactSheetLayout(MAX_CELLS_LIMIT + 1)).toThrow(
      /must be an integer in 1\.\./,
    );
    expect(() => planContactSheetLayout(1.5)).toThrow(/must be an integer in 1\.\./);
  });

  it("lays the default out as a 3x4 grid of 402x226 cells", () => {
    const layout = planContactSheetLayout(DEFAULT_MAX_CELLS);
    expect(layout).toMatchObject({
      columns: 3,
      rows: 4,
      cellWidth: 402,
      cellHeight: 226,
      blanks: 0,
    });
  });

  // The default is the largest count that still fills the pixel bound rather than being scaled
  // back to fit it — so no larger cap anywhere in range buys a bigger cell.
  it("is the largest count whose cells are not shrunk to fit the pixel bound", () => {
    const atDefault = planContactSheetLayout(DEFAULT_MAX_CELLS);
    for (let cap = DEFAULT_MAX_CELLS + 1; cap <= MAX_CELLS_LIMIT; cap++) {
      expect(planContactSheetLayout(cap).cellWidth).toBeLessThan(atDefault.cellWidth);
    }
  });

  it("holds one scale across a run's pages, padding a short last page with blanks", () => {
    const full = planContactSheetLayout(12, 12);
    const last = planContactSheetLayout(12, 3);
    expect(last.cellWidth).toBe(full.cellWidth);
    expect(last.cellHeight).toBe(full.cellHeight);
    expect(last).toMatchObject({ columns: 3, rows: 1, blanks: 0 });
  });

  it("pads to a full grid when the last page does not divide evenly", () => {
    const layout = planContactSheetLayout(12, 7);
    expect(layout).toMatchObject({ columns: 3, rows: 3, blanks: 2 });
  });

  it("keeps cell dimensions even", () => {
    for (let n = 1; n <= 40; n++) {
      const layout = planContactSheetLayout(n);
      expect(layout.cellWidth % 2).toBe(0);
      expect(layout.cellHeight % 2).toBe(0);
    }
  });

  it("rejects a page larger than the run's cap", () => {
    expect(() => planContactSheetLayout(12, 13)).toThrow(/A page holds 1\.\.12 cells/);
    expect(() => planContactSheetLayout(0)).toThrow(/must be an integer in 1\.\./);
  });

  it("gives whole groups a row that divides by the group size", () => {
    for (const groupSize of [2, 3, 4]) {
      for (let cap = groupSize; cap <= MAX_CELLS_LIMIT; cap += groupSize) {
        for (let count = groupSize; count <= cap; count += groupSize) {
          expect(planContactSheetLayout(cap, count, { groupSize }).columns % groupSize).toBe(0);
        }
      }
    }
  });

  it("still holds the vision-model bounds once columns round up to a group", () => {
    for (const groupSize of [2, 3, 4]) {
      for (let cap = groupSize; cap <= MAX_CELLS_LIMIT; cap += groupSize) {
        const layout = planContactSheetLayout(cap, cap, { groupSize });
        expect(Math.max(layout.sheetWidth, layout.sheetHeight)).toBeLessThanOrEqual(SHEET_MAX_EDGE);
        expect(layout.sheetWidth * layout.sheetHeight).toBeLessThanOrEqual(SHEET_MAX_PIXELS);
      }
    }
  });

  it("rejects a page that is not whole groups, and a group size that is not one", () => {
    expect(() => planContactSheetLayout(12, 7, { groupSize: 2 })).toThrow(
      /holds whole groups of 2/,
    );
    expect(() => planContactSheetLayout(12, 12, { groupSize: 2.5 })).toThrow(
      /must be a positive integer/,
    );
    expect(() => planContactSheetLayout(12, 12, { groupSize: 0 })).toThrow(
      /must be a positive integer/,
    );
  });

  it("keeps pairs on a row at the default board's cell size", () => {
    expect(
      planContactSheetLayout(DEFAULT_MAX_CELLS, DEFAULT_MAX_CELLS, { groupSize: 2 }),
    ).toMatchObject({ columns: 2, cellWidth: 402 });
  });

  it("fills a wide picture's cells instead of letterboxing it into 16:9", () => {
    const layout = planContactSheetLayout(DEFAULT_MAX_CELLS, DEFAULT_MAX_CELLS, { aspect: 4 });
    expect(layout).toMatchObject({ columns: 2, rows: 6, cellWidth: 600, cellHeight: 150 });
    expect(layout.cellWidth * layout.cellHeight).toBeGreaterThan(384 * 96);
  });

  it("holds the vision-model bounds at any aspect", () => {
    for (const aspect of [9 / 16, 1, 16 / 9, 2.39, 4, 8]) {
      for (const cap of [1, 2, 5, 12, 40, MAX_CELLS_LIMIT]) {
        const layout = planContactSheetLayout(cap, cap, { aspect });
        expect(Math.max(layout.sheetWidth, layout.sheetHeight)).toBeLessThanOrEqual(SHEET_MAX_EDGE);
        expect(layout.sheetWidth * layout.sheetHeight).toBeLessThanOrEqual(SHEET_MAX_PIXELS);
      }
    }
  });
});

describe("maxCellsForWidth", () => {
  it("fits as many cells as stay at least the asked width", () => {
    const { maxCells } = maxCellsForWidth(1200, { aspect: 4 });
    expect(maxCells).toBe(3);
    expect(planContactSheetLayout(3, 3, { aspect: 4 }).cellWidth).toBeGreaterThanOrEqual(1200);
    expect(planContactSheetLayout(4, 4, { aspect: 4 }).cellWidth).toBeLessThan(1200);
  });

  it("counts whole groups", () => {
    const { maxCells } = maxCellsForWidth(560, { groupSize: 2 });
    expect(maxCells! % 2).toBe(0);
    expect(
      planContactSheetLayout(maxCells!, maxCells!, { groupSize: 2 }).cellWidth,
    ).toBeGreaterThanOrEqual(560);
  });

  it("says how wide a lone cell gets when the asked width is past it", () => {
    expect(maxCellsForWidth(5000, { aspect: 4 })).toEqual({ maxCells: null, widest: 1556 });
  });
});

describe("sheetAspect", () => {
  it("takes the aspect most pictures share", () => {
    const cell = (aspect?: number) => ({ label: "", file: "", aspect });
    expect(sheetAspect([cell(4), cell(4), cell(2)])).toBe(4);
  });

  it("falls back to 16:9 when no picture's dimensions are known", () => {
    expect(sheetAspect([{ label: "", file: "" }])).toBeCloseTo(16 / 9);
  });
});

describe("paginateCells", () => {
  it("splits a board into full pages plus a remainder", () => {
    const cells = Array.from({ length: 27 }, (_, i) => i);
    const pages = paginateCells(cells, 12);
    expect(pages.map((p) => p.length)).toEqual([12, 12, 3]);
    expect(pages.flat()).toEqual(cells);
  });

  it("returns a single page when everything fits", () => {
    expect(paginateCells([1, 2, 3], 12)).toEqual([[1, 2, 3]]);
  });

  it("rejects a cap below one", () => {
    expect(() => paginateCells([1], 0)).toThrow(/--max-cells must be at least 1/);
  });
});

describe("paginateGroupedCells", () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("never splits a subject across sheets", () => {
    // Two shots, 2 and 3 keyframes. A flat cap of 3 cut the second shot in half and left page 2
    // holding a fraction of a group, which the layout then refused outright.
    const pages = paginateGroupedCells(cells(5), [2, 3], 3);
    expect(pages).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
  });

  it("fills a page with as many whole subjects as the cap holds", () => {
    expect(paginateGroupedCells(cells(9), [2, 2, 2, 3], 6)).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6, 7, 8],
    ]);
  });

  it("gives a subject wider than the cap a page of its own rather than cutting it", () => {
    expect(paginateGroupedCells(cells(6), [4, 2], 3)).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });

  it("returns one page when everything fits", () => {
    expect(paginateGroupedCells(cells(4), [2, 2], 12)).toEqual([[0, 1, 2, 3]]);
  });

  // A page the layout would refuse is worse than a split subject: `planContactSheetLayout` caps a
  // sheet at MAX_CELLS_LIMIT, so a shot past it has to be cut rather than announced and then failed.
  it("splits a subject that is wider than a sheet can lay out", () => {
    const n = MAX_CELLS_LIMIT + 1;
    const pages = paginateGroupedCells(cells(n), [n], MAX_CELLS_LIMIT);
    expect(pages.map((p) => p.length)).toEqual([MAX_CELLS_LIMIT, 1]);
    expect(pages.flat()).toEqual(cells(n));
  });

  // The counts are the caller's; a disagreement must not silently drop the tail.
  it("keeps cells the groups do not account for", () => {
    expect(paginateGroupedCells(cells(5), [2], 12)).toEqual([[0, 1, 2, 3, 4]]);
    expect(paginateGroupedCells(cells(3), [], 12)).toEqual([[0, 1, 2]]);
  });

  it("rejects a cap below one", () => {
    expect(() => paginateGroupedCells([1], [1], 0)).toThrow(/--max-cells must be at least 1/);
  });
});

describe("cellFilters", () => {
  // `tile` accumulates its whole grid before emitting; a pixel-format change part-way through the
  // image sequence reinitializes the filtergraph and drops everything accumulated, so a sheet whose
  // generated blanks differ in format from its source cells renders as the blanks alone. Both paths
  // must therefore end on the same explicit format.
  it("pins the same pixel format with and without a label", () => {
    const layout = planContactSheetLayout(12);
    expect(cellFilters(layout, null).endsWith("format=yuvj420p")).toBe(true);
    expect(cellFilters(layout, "/tmp/label.txt").endsWith("format=yuvj420p")).toBe(true);
  });

  it("burns the label before pinning the format", () => {
    const chain = cellFilters(planContactSheetLayout(12), "/tmp/label.txt");
    expect(chain.indexOf("drawtext")).toBeLessThan(chain.indexOf("format="));
  });
});

describe("escapeFilterPath", () => {
  // A filtergraph option value is parsed before drawtext sees it, so an unescaped Windows path
  // (drive colon + backslashes) or a tmpdir carrying a quote would break the filter and silently
  // drop labels.
  it("escapes the characters the filtergraph parser claims", () => {
    expect(escapeFilterPath(String.raw`C:\Users\a\label.txt`)).toBe(
      String.raw`C\:\\Users\\a\\label.txt`,
    );
    expect(escapeFilterPath("/tmp/it's/label.txt")).toBe("/tmp/it\\'s/label.txt");
  });

  it("leaves an ordinary posix path alone", () => {
    expect(escapeFilterPath("/tmp/konte-sheet-ab12/label-0.txt")).toBe(
      "/tmp/konte-sheet-ab12/label-0.txt",
    );
  });
});
