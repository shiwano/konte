import { z } from "zod";

// RFC 9110 field-name token.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// A value that is one `${VAR}`, optionally introduced by an auth scheme (`Bearer ${TOKEN}`).
const CREDENTIAL_VALUE_RE = /^(?:[A-Za-z][A-Za-z0-9-]* )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

// konte builds these per request. A configured one would replace the multipart boundary
// `/upload/image` generates, or address the request at a different server than the one it opened.
const RESERVED_HEADERS = new Set(["content-type", "content-length", "host"]);

/**
 * The headers whose value IS the credential — held to a `${VAR}`, since `konte.config.json` is not
 * gitignored. Compared lowercased: HTTP field names are case-insensitive.
 */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "cf-access-client-secret",
]);

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADERS.has(name.toLowerCase());
}

/** What is wrong with this header, or null if nothing is. The schema and the settings page share it. */
export function comfyHeaderIssue(name: string, value: string): string | null {
  if (!HEADER_NAME_RE.test(name)) return `"${name}" is not a valid HTTP header name`;
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) return `konte sets "${name}" itself`;
  if (SECRET_HEADERS.has(lower) && !CREDENTIAL_VALUE_RE.test(value)) {
    return (
      `"${name}" carries a credential, so its value must be a \${VAR} placeholder, alone or after ` +
      `an auth scheme (e.g. \${COMFYUI_TOKEN} or Bearer \${COMFYUI_TOKEN}). konte.config.json is ` +
      `not gitignored; store the value itself under Credentials in \`konte settings\`.`
    );
  }
  return null;
}

const ComfyUIHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const issue = comfyHeaderIssue(name, value);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: issue });
    // Field names are case-insensitive, so two spellings are one header: fetch would join their
    // values with a comma and send a credential neither half meant.
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: `"${name}" is set twice (header names are case-insensitive)`,
      });
    }
    seen.add(lower);
  }
});

// A `preview.allowedHosts` entry is a bare host name with `*` for a label, never a URL: it is
// compared against the `Host` header, which carries no scheme and no path.
const ALLOWED_HOST_RE = /^(?:\*|(?:\*|[A-Za-z0-9-]+)(?:\.(?:\*|[A-Za-z0-9-]+))*)$/;

/** What is wrong with this allowed-host pattern, or null if nothing is. */
export function allowedHostIssue(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === "") return "An allowed host cannot be empty";
  if (trimmed.includes("://") || trimmed.includes("/")) {
    return `"${pattern}" is a URL — write the host name alone (e.g. review.example.com)`;
  }
  if (trimmed.includes(":")) {
    return `"${pattern}" carries a port — write the host name alone; the port is not compared`;
  }
  if (!ALLOWED_HOST_RE.test(trimmed)) {
    return `"${pattern}" is not a host name pattern (e.g. *.trycloudflare.com)`;
  }
  return null;
}

export const KonteConfigSchema = z.object({
  comfyui: z
    .object({
      url: z.string().optional(),
      // Sent on every request to this server — a bearer token, a Basic credential, a Cloudflare
      // Access pair.
      headers: ComfyUIHeadersSchema.optional(),
      autoInstallModels: z.boolean().optional(),
      autoInstallNodes: z.boolean().optional(),
      autoRebootAfterNodeInstall: z.boolean().optional(),
      // How many minutes a generation job keeps polling a ComfyUI it cannot reach at all before it
      // is failed. 0 waits forever (the cloud backends' contract) — right for a remote ComfyUI
      // whose outages are network-side, wrong for a local one, whose prompts die with the process.
      unreachableTimeoutMinutes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  local: z
    .object({
      ffmpegPath: z.string().optional(),
      ffprobePath: z.string().optional(),
    })
    .optional(),
  preview: z
    .object({
      // The address the preview server binds. Loopback by default; `0.0.0.0` also listens on the
      // machine's LAN addresses, which is what a phone on the same network reaches it at. A tunnel
      // needs none of this: it connects to loopback and konte admits the host name it reports.
      host: z.string().trim().min(1).optional(),
      // Host names admitted on top of loopback and, when `host` listens off it, the private ranges.
      // `*` stands for one label; the bare `*` admits any name.
      allowedHosts: z
        .array(
          z
            .string()
            .trim()
            .superRefine((pattern, ctx) => {
              const issue = allowedHostIssue(pattern);
              if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
            }),
        )
        .optional(),
    })
    .optional(),
});

export type KonteConfig = z.infer<typeof KonteConfigSchema>;
export type ComfyUIHeaders = Record<string, string>;
