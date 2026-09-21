import { missingCredentialMessage } from "../core/credentials.js";
import { KonteError } from "../core/errors.js";

export type FalConfig = {
  apiKey: string;
};

export async function resolveFalConfig(): Promise<FalConfig> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new KonteError("FAL_AUTH_MISSING", missingCredentialMessage("FAL_KEY"));
  }
  return { apiKey };
}
