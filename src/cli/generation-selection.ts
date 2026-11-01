/** What a spend prints for the board stems it re-mixed before its gate, and the ones it could not. */
export function printRemixedBoardStems(
  result: {
    accepted: ReadonlyArray<{ address: string }>;
    failed?: ReadonlyArray<{ address: string; reason: string }>;
  },
  opts: { plan?: boolean } = {},
): void {
  if (result.accepted.length > 0) {
    console.log(
      `${opts.plan ? "Would re-mix" : "Re-mixed"} ${result.accepted.length} board stem(s) the ` +
        `video develops past their review: ${result.accepted.map((s) => s.address).join(", ")}`,
    );
  }
  for (const { address, reason } of result.failed ?? []) {
    console.log(`Could not re-mix ${address}: ${reason}`);
  }
}
