/** Where a pointer landed in `rect`, as 0–1 coordinates rounded to three decimals. */
export function normalizedPointIn(
  rect: DOMRect,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const clamp = (n: number) => Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
  return {
    x: clamp((e.clientX - rect.left) / rect.width),
    y: clamp((e.clientY - rect.top) / rect.height),
  };
}
