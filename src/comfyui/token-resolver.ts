import { KonteError } from "../core/errors.js";
import { PLACEHOLDER_RE } from "../core/redact.js";

interface TokenSource {
  env?: NodeJS.ProcessEnv;
}

function substitute(text: string, env: NodeJS.ProcessEnv): { resolved: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = text.replace(PLACEHOLDER_RE, (_match, varName: string) => {
    const fromEnv = env[varName];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    missing.push(varName);
    return "";
  });
  return { resolved, missing };
}

function missingTokenError(missing: readonly string[], where: string): KonteError {
  const unique = Array.from(new Set(missing));
  return new KonteError(
    "MISSING_TOKEN",
    `Cannot resolve ${unique.map((v) => `\${${v}}`).join(", ")} in ${where}. ` +
      `Run "konte settings" and set ${unique.join(", ")} under Credentials (or as environment variables). ` +
      `If a konte MCP server is running, restart it.`,
  );
}

export function resolveUrlTokens(url: string, source: TokenSource = {}): string {
  const { resolved, missing } = substitute(url, source.env ?? process.env);
  if (missing.length > 0) throw missingTokenError(missing, `model URL. URL: ${url}`);
  return resolved;
}

/** The configured ComfyUI headers with their `${VAR}`s filled in — built per request, never held. */
export function resolveHeaderTokens(
  headers: Readonly<Record<string, string>>,
  source: TokenSource = {},
): Record<string, string> {
  const env = source.env ?? process.env;
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    const { resolved, missing } = substitute(template, env);
    if (missing.length > 0) throw missingTokenError(missing, `comfy.comfyui.headers."${name}"`);
    out[name] = resolved;
  }
  return out;
}
