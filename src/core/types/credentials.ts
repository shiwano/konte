import { z } from "zod";
import type { VendorBackendKind } from "./job.js";

// A credential is keyed by the environment variable it becomes, so the same name works from a
// shell, from CI, and inside an adapter's `${VAR}` model URL.
const CREDENTIAL_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CredentialKeySchema = z.string().regex(CREDENTIAL_KEY_RE);

export const KonteCredentialsSchema = z.record(CredentialKeySchema, z.string());
export type KonteCredentials = z.infer<typeof KonteCredentialsSchema>;

/**
 * What the settings page sends: only the keys the human touched. It never held the stored values,
 * so it cannot send back a document that keeps the ones it did not see.
 */
// Strict: a misspelled field would otherwise be stripped, and the save would report success
// having done nothing.
export const CredentialsPatchSchema = z
  .object({
    set: z.record(CredentialKeySchema, z.string()).optional(),
    unset: z.array(CredentialKeySchema).optional(),
  })
  .strict();
export type CredentialsPatch = z.infer<typeof CredentialsPatchSchema>;

interface KnownCredential {
  key: string;
  label: string;
  /** Where the user obtains the value. */
  obtainUrl: string;
  /** The vendor this authenticates; absent for a model-host credential. */
  backend?: VendorBackendKind;
  /** What konte does with the value. */
  help: string;
}

/**
 * The credentials konte knows by name: what to call them, where to get them, and how they are
 * used. The settings page builds its form from this, `doctor` and the backends name a missing one
 * from it. The set is not closed: a custom adapter may write any `${VAR}` into a model URL.
 */
export const KNOWN_CREDENTIALS: readonly KnownCredential[] = [
  {
    key: "FAL_KEY",
    label: "fal.ai API key",
    obtainUrl: "https://fal.ai/dashboard/keys",
    backend: "fal",
    help: "Authenticates every fal.ai generation.",
  },
  {
    key: "HF_TOKEN",
    label: "HuggingFace access token",
    obtainUrl: "https://huggingface.co/settings/tokens",
    help:
      "Only needed for gated or private repos. konte sends it as the bearer credential when it " +
      "downloads a model from huggingface.co — keep the URL in the adapter plain.",
  },
  {
    // No `backend`: what authorizes comfy spend is `comfyui.url`.
    key: "COMFYUI_TOKEN",
    label: "ComfyUI server credential",
    obtainUrl: "https://docs.comfy.org/development/comfyui-server/comms_overview",
    help:
      "Only needed for a ComfyUI behind an auth front (a remote pod, a reverse proxy). Reference " +
      'it from konte.config.json: "comfyui": { "headers": { "Authorization": "Bearer ${COMFYUI_TOKEN}" } }',
  },
  {
    key: "CIVITAI_TOKEN",
    label: "Civitai API token",
    obtainUrl: "https://civitai.com/user/account",
    help:
      "Used as the `?token=` query param, so an adapter's model URL writes it in: " +
      "https://civitai.com/api/download/models/<id>?token=${CIVITAI_TOKEN}",
  },
];

export function knownCredential(key: string): KnownCredential | undefined {
  return KNOWN_CREDENTIALS.find((c) => c.key === key);
}

/** The credential a vendor backend authenticates with; absent for one that needs none. */
export function backendCredential(backend: VendorBackendKind): KnownCredential | undefined {
  return KNOWN_CREDENTIALS.find((c) => c.backend === backend);
}
