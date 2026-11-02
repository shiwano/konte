import type { KonteConfig } from "../../core/types/config.js";
import type { CredentialsPatch } from "../../core/types/credentials.js";
import { jsonBody, requestJson } from "../shared/http.js";
import type { CredentialsResponse } from "./types.js";

export function fetchConfig(): Promise<KonteConfig> {
  return requestJson<KonteConfig>("/api/config");
}

export function saveConfig(config: KonteConfig): Promise<KonteConfig> {
  return requestJson<KonteConfig>("/api/config", jsonBody("PUT", config));
}

export function fetchCredentials(): Promise<CredentialsResponse> {
  return requestJson<CredentialsResponse>("/api/credentials");
}

export function saveCredentials(patch: CredentialsPatch): Promise<CredentialsResponse> {
  return requestJson<CredentialsResponse>("/api/credentials", jsonBody("PUT", patch));
}
