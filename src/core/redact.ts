// Reduce a URL to origin+path, dropping the query and fragment where a signed delivery token
// lives — so a failed-download message can name the file without persisting the credential to
// job/log. A non-URL string is truncated at the first `?`/`#` as a best effort.
export function redactUrlSecret(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\\]+/g;

export const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Cap for an external error body embedded in a persisted error. A backend that answers a bad
// request with a full HTML page must not push kilobytes into every job file and log.
const MAX_ERROR_BODY_CHARS = 500;

/**
 * An external server's response text, made safe to embed in a KonteError persisted to
 * `.konte/jobs.db` and `.konte/logs/`: every resolved `${VAR}` of `templates` reversed to its
 * placeholder, every URL stripped to origin+path, then the length bounded. Truncation comes last
 * so a cut cannot split a secret before it is matched.
 */
export function redactExternalBody(
  body: string,
  templates: readonly string[],
  source: { env?: NodeJS.ProcessEnv } = {},
): string {
  const redacted = redactUrls(buildTokenRedactor(templates, source)(unescapeJsonSlashes(body)));
  return redacted.length > MAX_ERROR_BODY_CHARS
    ? `${redacted.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`
    : redacted;
}

export function redactUrls(body: string): string {
  return unescapeJsonSlashes(body).replace(URL_IN_TEXT, (url) => redactUrlSecret(url));
}

function unescapeJsonSlashes(text: string): string {
  return text.replace(/\\\//g, "/");
}

// Build a redactor that reverses resolved token values back to their `${VAR}` placeholders.
// Given the unresolved templates a request was built from, it maps each substituted secret to
// `${VAR}`, so a server that echoes a credential never lands it on disk.
function buildTokenRedactor(
  templates: readonly string[],
  source: { env?: NodeJS.ProcessEnv } = {},
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
