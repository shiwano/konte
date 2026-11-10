import { missingCredentialMessage } from "../core/credentials.js";
import { KonteError } from "../core/errors.js";

/** FAL_KEY as the environment holds it at this call. */
export function falKey(): string {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new KonteError("BACKEND_NOT_CONFIGURED", missingCredentialMessage("FAL_KEY"));
  }
  return apiKey;
}
