import type { VendorBackendKind } from "../../core/types/job.js";

export const SETTINGS_TABS = ["config", "credentials"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The page shows whether a key is set, never what it is set to. */
export interface CredentialEntry {
  key: string;
  isSet: boolean;
  /** A real environment variable of this name is in effect, and overrides the stored one. */
  fromEnvironment: boolean;
  /** konte ships a label, a source and help for this key. */
  known: boolean;
  label?: string;
  obtainUrl?: string;
  help?: string;
  backend?: VendorBackendKind;
}

export interface CredentialsResponse {
  entries: CredentialEntry[];
}
