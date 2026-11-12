import type { KonteConfig } from "../../core/types/config.js";
import type { CredentialsPatch } from "../../core/types/credentials.js";
import { jsonBody, requestJson } from "../shared/http.js";
import { reportSessionLoss, withSession } from "./session.js";
import type { CredentialsResponse } from "./types.js";

function call<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, withSession(init)).catch(reportSessionLoss);
}

export function fetchConfig(): Promise<KonteConfig> {
  return call<KonteConfig>("/api/config");
}

export function saveConfig(config: KonteConfig): Promise<KonteConfig> {
  return call<KonteConfig>("/api/config", jsonBody("PUT", config));
}

export function fetchCredentials(): Promise<CredentialsResponse> {
  return call<CredentialsResponse>("/api/credentials");
}

export function saveCredentials(patch: CredentialsPatch): Promise<CredentialsResponse> {
  return call<CredentialsResponse>("/api/credentials", jsonBody("PUT", patch));
}
