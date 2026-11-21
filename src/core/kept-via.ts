const KEPT_VIA = "via:";

/**
 * The `keptInputs` value for an input reached through takes konte re-makes on its own — a
 * deterministic intermediate, a stem: kept against the upstream takes it is to be made from, since
 * its own hash is not known until it is.
 */
export function keptViaMarker(upstreams: Readonly<Record<string, string>>): string {
  return (
    KEPT_VIA +
    Object.keys(upstreams)
      .sort()
      .map((address) => `${address}=${upstreams[address]}`)
      .join(",")
  );
}

export function parseKeptVia(value: string): Record<string, string> | null {
  if (!value.startsWith(KEPT_VIA)) return null;
  const out: Record<string, string> = {};
  for (const pair of value.slice(KEPT_VIA.length).split(",")) {
    const at = pair.lastIndexOf("=");
    if (at <= 0) return null;
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}
