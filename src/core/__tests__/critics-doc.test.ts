import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRITICS } from "../critic-checks.js";
import { renderCriticsDoc } from "../critics-doc.js";
import { isFindingCode } from "../findings-doc.js";

// Backticked kebab-case words a contract uses that are neither its codes nor findings.
const VOCABULARY = new Set(["jump-back", "jump-forward", "smallest-fix", "direction-guide"]);

function contract(name: string): string {
  return readFileSync(new URL(`../../cli/templates/agents/${name}.md`, import.meta.url), "utf-8");
}

describe("docs/CRITICS.md", () => {
  it("matches the critic registry", async () => {
    const onDisk = readFileSync(new URL("../../../docs/CRITICS.md", import.meta.url), "utf-8");
    expect(onDisk, "stale — run `bun run build:generate-critics-doc`").toBe(
      await renderCriticsDoc(),
    );
  });
});

describe.each(CRITICS.map((critic) => [critic.name, critic] as const))(
  "%s contract",
  (_name, critic) => {
    const body = contract(critic.name);
    const codes = new Set(critic.checks.map((check) => check.code));
    const critics = new Set(CRITICS.map((c) => c.name));

    it("lists each code once", () => {
      expect(codes.size).toBe(critic.checks.length);
    });

    it("names every registered code", () => {
      const missing = [...codes].filter((code) => !body.includes(`\`${code}\``));
      expect(missing).toEqual([]);
    });

    it("reports no code the registry lacks", () => {
      const unknown = [...body.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)]
        .map((m) => m[1]!)
        .filter(
          (word) =>
            !codes.has(word) && !isFindingCode(word) && !VOCABULARY.has(word) && !critics.has(word),
        );
      expect([...new Set(unknown)]).toEqual([]);
    });

    it("gives its output example registered codes", () => {
      const examples = [...body.matchAll(/^\s+problem: (\S+)$/gm)].map((m) => m[1]!);
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.filter((code) => !codes.has(code))).toEqual([]);
    });

    it("shares no code with a machine finding", () => {
      expect([...codes].filter(isFindingCode)).toEqual([]);
    });
  },
);
