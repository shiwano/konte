import { isUnexposedPlateAddress, tryParseAddress, type DefinitionLike } from "./address.js";

/** A plate's setup and every shot standing on it. */
export type SetupFork = { setupId: string; shotIds: readonly string[] };

/**
 * The fork alternative for a plate address, read off the cascade rather than the `setups` roster: a
 * shot that names the setup but builds on nothing of it pays nothing for the edit (that is
 * `setup-unconsumed`'s business). Null for a non-plate, for a plate one shot alone stands on, and
 * for an intermediate the plates are built from, which is filed under no setup to fork.
 */
export function plateFork(
  address: string,
  cascade: ReadonlyArray<{ assetPath: string }>,
  definition?: DefinitionLike,
): SetupFork | null {
  const parsed = tryParseAddress(address);
  if (parsed?.kind !== "plate") return null;
  if (isUnexposedPlateAddress(definition, address)) return null;
  const shotIds = [
    ...new Set(
      cascade.flatMap((c) => {
        const dep = tryParseAddress(c.assetPath);
        return dep?.kind === "shot" ? [dep.shotId] : [];
      }),
    ),
  ];
  return shotIds.length >= 2 ? { setupId: parsed.assetName, shotIds } : null;
}
