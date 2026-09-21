import type { KonteConfig } from "../../core/types/config.js";
import type { CredentialsPatch } from "../../core/types/credentials.js";
import type { CredentialsResponse } from "./types.js";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

function put(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function fetchConfig(): Promise<KonteConfig> {
  return request<KonteConfig>("/api/config");
}

export function saveConfig(config: KonteConfig): Promise<KonteConfig> {
  return request<KonteConfig>("/api/config", put(config));
}

export function fetchCredentials(): Promise<CredentialsResponse> {
  return request<CredentialsResponse>("/api/credentials");
}

export function saveCredentials(patch: CredentialsPatch): Promise<CredentialsResponse> {
  return request<CredentialsResponse>("/api/credentials", put(patch));
}
