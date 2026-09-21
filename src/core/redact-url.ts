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

// Cap for an external error body embedded in a persisted error. A backend that answers a bad
// request with a full HTML page must not push kilobytes into every job file and log.
const MAX_ERROR_BODY_CHARS = 500;

// Sanitize an external server's error response body before it is embedded in a KonteError that
// gets persisted to `.konte/jobs.db` and `.konte/logs/`. A backend commonly echoes the request it
// rejected — including a signed input URL whose query carries the delivery token — so strip every
// URL down to origin+path, then bound the length.
export function redactErrorBody(body: string): string {
  const redacted = redactUrls(body);
  return redacted.length > MAX_ERROR_BODY_CHARS
    ? `${redacted.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`
    : redacted;
}

export function redactUrls(body: string): string {
  // JSON may escape URL slashes.
  const normalized = body.replace(/\\\//g, "/");
  return normalized.replace(URL_IN_TEXT, (url) => redactUrlSecret(url));
}
