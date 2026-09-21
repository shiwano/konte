import { KonteError } from "../core/errors.js";

interface TokenSource {
  env?: NodeJS.ProcessEnv;
}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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
      `Run "konte settings" and set ${unique.join(", ")} under Credentials (or export them). ` +
      `If a konte MCP server is running, restart it so it picks up the current credentials.`,
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
    if (missing.length > 0) throw missingTokenError(missing, `comfyui.headers."${name}"`);
    out[name] = resolved;
  }
  return out;
}

// Build a redactor that reverses resolved token values back to their `${VAR}` placeholders,
// for scrubbing an external server's response before it is persisted (job file, log). Given the
// unresolved templates a request was built from, it maps each substituted secret to `${VAR}` —
// so a server that echoes a token-bearing URL never lands a live credential on disk.
export function buildTokenRedactor(
  templates: readonly string[],
  source: TokenSource = {},
): (text: string) => string {
  const env = source.env ?? process.env;
  const replacements: Array<{ value: string; placeholder: string }> = [];
  for (const template of templates) {
    for (const match of template.matchAll(PLACEHOLDER_RE)) {
      const varName = match[1]!;
      const value = env[varName];
      if (typeof value === "string" && value.length > 0) {
        replacements.push({ value, placeholder: `\${${varName}}` });
      }
    }
  }
  // Replace longest values first so a secret that contains another isn't left partly exposed.
  replacements.sort((a, b) => b.value.length - a.value.length);
  return (text: string): string => {
    let out = text;
    for (const { value, placeholder } of replacements) {
      out = out.split(value).join(placeholder);
    }
    return out;
  };
}
