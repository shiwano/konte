function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// Orientation-significant: 1080×1920 reduces to "9:16", 1920×1080 to "16:9". Width and height are
// never swapped, so a landscape size never satisfies a portrait aspect.
export function ratioOf(size: { width: number; height: number }): string {
  const g = gcd(size.width, size.height) || 1;
  return `${size.width / g}:${size.height / g}`;
}

export function sameAspect(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return ratioOf(a) === ratioOf(b);
}
