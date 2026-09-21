/**
 * What every review page's bulk accept ("Accept all") does, what it reads as, and what it leaves
 * outstanding. Given the page's complete unit list and the reader its own accept controls use,
 * these come from one description of the work, so the count, the button's label and the "Needs
 * review" filter cannot describe different sets. Computing any of them from a predicate of its own
 * is how a page ends up counting work no action on it can discharge. (A page may narrow `pending`
 * for an affordance of narrower scope — the reel's "Next" is its shot list's own control — but it
 * narrows this answer rather than forming another.)
 *
 * Two facts have to line up for that, and they are independent, so this enforces one and checks the
 * other:
 *
 *  - Outstanding means "not accepted", read by `isAccepted`. There is no second predicate to widen
 *    it with.
 *  - The button has to be able to reach "accepted" for everything counted. The action is given per
 *    unit (`acceptOne`) and folded over `units` into the returned `apply`, so the units counted and
 *    the units acted on are one list; that the fold actually leaves each one accepted is reported
 *    from `apply`.
 *
 * What is left to the caller: that `units` holds every unit the page renders an accept control for,
 * and that `isAccepted` is the reader that control itself uses. The button's onClick must apply the
 * returned `apply` rather than an action of its own.
 */
export function bulkAcceptState<Unit, Marks>(
  units: readonly Unit[],
  marks: Marks,
  acceptOne: (unit: Unit, marks: Marks) => Marks,
  isAccepted: (unit: Unit, marks: Marks) => boolean,
): { pending: Unit[]; done: boolean; apply: (marks: Marks) => Marks } {
  const apply = (m: Marks): Marks => {
    const after = units.reduce((acc, u) => acceptOne(u, acc), m);
    reportUnacceptedAfterBulk(units, after, isAccepted);
    return after;
  };
  const pending = units.filter((u) => !isAccepted(u, marks));
  // No units at all is not "done": a page with nothing to sign off has no verdict to report, and
  // its caller drops the affordance.
  return { pending, done: units.length > 0 && pending.length === 0, apply };
}

/**
 * A unit still unaccepted after the bulk action is one no press of the button can clear — the page
 * would count it forever. That is a bug in the page's own `acceptOne`/`isAccepted` pair. Reported,
 * not thrown — a review page blanked mid-session costs the reviewer more than the bug it names.
 */
function reportUnacceptedAfterBulk<Unit, Marks>(
  units: readonly Unit[],
  after: Marks,
  isAccepted: (unit: Unit, marks: Marks) => boolean,
): void {
  const stuck = units.filter((u) => !isAccepted(u, after));
  if (stuck.length > 0) {
    console.error("bulkAcceptState: units the bulk accept cannot accept", stuck);
  }
}
