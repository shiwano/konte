import { describe, expect, it, vi } from "vitest";
import { bulkAcceptState } from "../bulk-accept.js";

// A page's marks, in the shape they all share: a mark per unit, absent meaning "read the baseline".
type Marks = Record<string, boolean>;
const state = (units: string[], accepted: Marks, marks: Marks = {}) =>
  bulkAcceptState(
    units,
    marks,
    (unit: string, m: Marks) => ({ ...m, [unit]: true }),
    (unit: string, m: Marks) => m[unit] ?? accepted[unit] ?? false,
  );

describe("bulkAcceptState", () => {
  it("counts the units not yet accepted, and reads done when none are left", () => {
    const some = state(["a", "b"], { a: true });
    expect(some.pending).toEqual(["b"]);
    expect(some.done).toBe(false);

    const all = state(["a", "b"], { a: true, b: true });
    expect(all.pending).toEqual([]);
    expect(all.done).toBe(true);
  });

  // The shipped bug: an accepted-but-stale asset was counted as outstanding while the accept it
  // asked for settled nothing. Outstanding is "not accepted" and nothing else — a unit the reader
  // calls accepted is not counted, whatever else is true of it.
  it("does not count a unit its reader calls accepted", () => {
    expect(state(["a"], { a: true }).pending).toEqual([]);
  });

  // Reset, or an un-accept the reviewer made this session: the count rises and Accept all wakes up.
  it("counts a unit the reviewer un-accepted this session", () => {
    const { pending, done } = state(["a"], { a: true }, { a: false });
    expect(pending).toEqual(["a"]);
    expect(done).toBe(false);
  });

  // A page with nothing to sign off has no verdict to report. Its caller drops the affordance
  // rather than showing one that reads finished over an empty page.
  it("does not read done when there are no units at all", () => {
    expect(state([], {})).toMatchObject({ pending: [], done: false });
  });

  it("applies the action to every unit it counts, and to no other", () => {
    const { apply } = state(["a", "b"], {});
    expect(apply({ c: false })).toEqual({ a: true, b: true, c: false });
  });

  // The half no signature can enforce: `acceptOne` and `isAccepted` are independent facts about a
  // page, so a pair that disagrees is caught rather than leaving a count no press can clear. On the
  // press, not on the read — the reviewer meets the symptom there, and building the whole result
  // speculatively on every render would cost every page that never presses it.
  it("reports a unit the bulk action cannot actually accept, when it is applied", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { apply } = bulkAcceptState(
      ["a", "b"],
      {} as Marks,
      (unit: string, m: Marks) => (unit === "b" ? m : { ...m, [unit]: true }),
      (unit: string, m: Marks) => m[unit] ?? false,
    );
    expect(error).not.toHaveBeenCalled();
    apply({});
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot accept"), ["b"]);
    error.mockRestore();
  });
});
