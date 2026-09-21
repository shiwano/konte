import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import { withFileLock } from "./file-lock.js";
import {
  knownCredential,
  type KonteCredentials,
  KonteCredentialsSchema,
} from "./types/credentials.js";

const CREDENTIALS_FILE = "konte.credentials.json";

export function credentialsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CREDENTIALS_FILE);
}

/**
 * The one wording for "this credential is missing", so a backend's auth failure and `doctor`'s
 * survey line say the same thing and name the same place to fix it.
 */
export function missingCredentialMessage(key: string): string {
  const known = knownCredential(key);
  const where = known ? ` Get one from ${known.obtainUrl}.` : "";
  return `${key} is not set. Run "konte settings" and set it under Credentials (or export it in your environment).${where}`;
}

/**
 * Reads `<workspaceRoot>/konte.credentials.json`. There is one per workspace; a video does not
 * carry its own.
 *
 * Only a missing file is silence. A file konte cannot read or parse is reported — a credential
 * that fails to load otherwise surfaces much later, as an auth error from a backend.
 */
export async function loadCredentials(workspaceRoot: string): Promise<KonteCredentials> {
  const filePath = credentialsPath(workspaceRoot);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new KonteError(
      "CREDENTIALS_UNREADABLE",
      `Cannot read "${filePath}": ${(err as Error).message}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new KonteError("VALIDATION_FAILED", `Invalid JSON in credentials file "${filePath}"`);
  }

  const result = KonteCredentialsSchema.safeParse(json);
  if (!result.success) {
    // The message names keys, never values.
    throw new KonteError(
      "VALIDATION_FAILED",
      `Credentials validation failed for "${filePath}": every entry must be a string keyed by an environment variable name`,
    );
  }
  return result.data;
}

export async function saveCredentials(
  workspaceRoot: string,
  credentials: KonteCredentials,
): Promise<void> {
  const validated = KonteCredentialsSchema.parse(credentials);
  await writeFileAtomic(
    credentialsPath(workspaceRoot),
    `${JSON.stringify(validated, null, 2)}\n`,
    // Owner-only: on a shared machine the workspace directory itself is often world-readable.
    { mode: 0o600 },
  );
}

/**
 * Every edit is a read-modify-write over one shared document, so two settings windows saving
 * different keys at the same moment would otherwise each write the version they read, and the
 * later rename would drop the other's key.
 */
export async function updateCredentials(
  workspaceRoot: string,
  mutate: (current: KonteCredentials) => KonteCredentials,
): Promise<KonteCredentials> {
  return withFileLock(`${credentialsPath(workspaceRoot)}.lock`, async () => {
    const next = mutate(await loadCredentials(workspaceRoot));
    await saveCredentials(workspaceRoot, next);
    return next;
  });
}

// What `applyCredentials` put there itself. Once it has run, a stored credential is in
// `process.env` because konte just wrote it, so `process.env` alone can no longer answer "does a
// real environment variable override the file" — every stored key would look overridden. The value
// is kept alongside the key so that something replacing the variable afterwards reads as the
// override it is.
const injected = new Map<string, string>();

/**
 * Puts the workspace's credentials into `process.env` so the backend SDKs and the `${VAR}` model
 * URLs find them where they already look. A real environment variable always wins, so a shell or
 * a CI run overrides the file — but an empty one is not a credential, and does not.
 *
 * Re-runnable, and the long-lived MCP daemon runs it again on its reconcile tick. Only konte's
 * own injections move — a real environment variable keeps winning, whenever
 * it arrived. Returns whether the environment changed, so a caller holding anything built from a
 * credential (a backend instance) can drop it.
 */
export async function applyCredentials(workspaceRoot: string): Promise<boolean> {
  const stored = await loadCredentials(workspaceRoot);
  let changed = false;

  for (const [key, value] of Object.entries(stored)) {
    const current = process.env[key] ?? "";
    if (current !== "" && injected.get(key) !== current) continue;
    if (current === value) continue;
    process.env[key] = value;
    injected.set(key, value);
    changed = true;
  }

  // A credential deleted from the file leaves the environment with it — unless something else has
  // taken the name over since.
  for (const [key, value] of [...injected]) {
    if (key in stored) continue;
    if ((process.env[key] ?? "") === value) delete process.env[key];
    injected.delete(key);
    changed = true;
  }

  return changed;
}

/** Is this key set in the environment by something other than the workspace's own file? */
export function hasEnvironmentOverride(key: string): boolean {
  const current = process.env[key] ?? "";
  return current !== "" && injected.get(key) !== current;
}
