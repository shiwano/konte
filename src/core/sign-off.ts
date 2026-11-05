// Whether the take accepted at an address was drawn from its definition as it stands.
export type Accepted = (address: string) => boolean;

export function signedOffBy(
  judgedBy: readonly string[] | undefined,
  accepted: Accepted | undefined,
): boolean {
  return (
    judgedBy !== undefined &&
    judgedBy.length > 0 &&
    accepted !== undefined &&
    judgedBy.every(accepted)
  );
}

// A message naming the `judgedBy` addresses still owed an accept, where an accept has landed on
// some of them.
export function withAwaitingAccept(
  message: string,
  judgedBy: readonly string[] | undefined,
  accepted: Accepted | undefined,
): string {
  if (!judgedBy || !accepted) return message;
  const awaiting = judgedBy.filter((address) => !accepted(address));
  if (awaiting.length === 0 || awaiting.length === judgedBy.length) return message;
  return `${message} — awaiting accept: ${awaiting.join(", ")}`;
}
