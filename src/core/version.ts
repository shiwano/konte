const RELEASE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

/** Whether `version` is `X.Y.Z` with an optional pre-release suffix and build metadata. */
export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(normalizeVersion(version));
}

/** Positive when `a` is newer than `b`; dotted numeric parts, a pre-release suffix ranks below its release, build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const [aMain, aPre] = splitPre(stripBuild(normalizeVersion(a)));
  const [bMain, bPre] = splitPre(stripBuild(normalizeVersion(b)));
  const aParts = aMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bParts = bMain.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return comparePre(aPre, bPre);
}

function stripBuild(version: string): string {
  const i = version.indexOf("+");
  return i === -1 ? version : version.slice(0, i);
}

function splitPre(version: string): [string, string | null] {
  const i = version.indexOf("-");
  return i === -1 ? [version, null] : [version.slice(0, i), version.slice(i + 1)];
}

function comparePre(a: string, b: string): number {
  const aIds = a.split(".");
  const bIds = b.split(".");
  for (let i = 0; i < Math.min(aIds.length, bIds.length); i++) {
    const diff = compareIdentifier(aIds[i]!, bIds[i]!);
    if (diff !== 0) return diff;
  }
  return aIds.length - bIds.length;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
