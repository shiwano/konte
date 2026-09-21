// A pre-flight "NOTICE" block for CLI output: a "NOTICE: <title>" header followed by
// indented detail lines. Generic so any command can surface one — not tied to a
// particular subject (comfy downloads being the first caller).
export function formatNotice(title: string, lines: readonly string[]): string {
  return [`NOTICE: ${title}`, ...lines.map((line) => `  ${line}`)].join("\n");
}
