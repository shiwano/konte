import { format } from "oxfmt";
import { CRITICS } from "./critic-checks.js";
import { findingLink } from "./findings-doc.js";

export async function renderCriticsDoc(): Promise<string> {
  const { code, errors } = await format("docs/CRITICS.md", renderCriticsMarkdown());
  if (errors.length > 0)
    throw new Error(`oxfmt failed on the critics list: ${JSON.stringify(errors)}`);
  return code;
}

function renderCriticsMarkdown(): string {
  const lines: string[] = [
    "# Critics",
    "",
    "<!-- Generated from src/core/critic-checks.ts by `bun run build:generate-critics-doc`. Do not edit by hand: src/core/__tests__/critics-doc.test.ts fails when this file, the code or a critic contract disagree. -->",
    "",
    "Every problem code a shipped critic subagent reports. Each contract is `src/cli/templates/agents/<critic>.md`.",
    "",
    "- **Machine** — the findings ([FINDINGS.md](FINDINGS.md)) that settle the formal half of the check on the artifact the critic reads; the critic judges what they leave.",
  ];
  for (const critic of CRITICS) {
    lines.push(
      "",
      `## ${critic.name}`,
      "",
      `Reviews ${critic.reviews}`,
      "",
      "| Code | Checks | Machine |",
      "| --- | --- | --- |",
      ...critic.checks.map(
        (check) =>
          `| \`${check.code}\` | ${check.checks} | ${check.machine?.map(findingLink).join("<br>") ?? "—"} |`,
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}
