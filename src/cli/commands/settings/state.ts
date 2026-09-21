import {
  hasEnvironmentOverride,
  loadCredentials,
  updateCredentials,
} from "../../../core/credentials.js";
import type { CredentialsPatch, KonteCredentials } from "../../../core/types/credentials.js";
import { KNOWN_CREDENTIALS, knownCredential } from "../../../core/types/credentials.js";
import type { CredentialEntry } from "../../../pages/settings/types.js";

/**
 * Which credentials exist and which are set — never what they are. A value that reached the page
 * could be read back off the screen — konte's own agents drive this UI in a headless browser.
 */
export async function credentialEntries(workspaceRoot: string): Promise<CredentialEntry[]> {
  const stored = await loadCredentials(workspaceRoot);
  const entries: CredentialEntry[] = KNOWN_CREDENTIALS.map((known) => ({
    key: known.key,
    label: known.label,
    obtainUrl: known.obtainUrl,
    help: known.help,
    backend: known.backend,
    isSet: (stored[known.key] ?? "") !== "",
    // A real environment variable wins over the file, so the page must say so.
    fromEnvironment: hasEnvironmentOverride(known.key),
    known: true,
  }));

  // A custom adapter may write any `${VAR}` into a model URL, so the set is not closed.
  for (const key of Object.keys(stored)) {
    if (knownCredential(key)) continue;
    entries.push({
      key,
      isSet: (stored[key] ?? "") !== "",
      fromEnvironment: hasEnvironmentOverride(key),
      known: false,
    });
  }

  return entries;
}

/**
 * An empty value is a removal — a stored key with no value would read as configured and
 * authenticate nothing.
 */
export function applyCredentialsPatch(
  stored: KonteCredentials,
  patch: CredentialsPatch,
): KonteCredentials {
  const next = { ...stored };
  for (const key of patch.unset ?? []) delete next[key];
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (value === "") delete next[key];
    else next[key] = value;
  }
  return next;
}

export async function saveCredentialsPatch(
  workspaceRoot: string,
  patch: CredentialsPatch,
): Promise<CredentialEntry[]> {
  await updateCredentials(workspaceRoot, (stored) => applyCredentialsPatch(stored, patch));
  return credentialEntries(workspaceRoot);
}
