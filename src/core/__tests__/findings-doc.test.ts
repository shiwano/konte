import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderFindingsDoc } from "../findings-doc.js";

describe("docs/FINDINGS.md", () => {
  it("matches the finding set the code reports", async () => {
    const onDisk = readFileSync(new URL("../../../docs/FINDINGS.md", import.meta.url), "utf-8");
    expect(onDisk, "stale — run `bun run build:generate-findings-doc`").toBe(
      await renderFindingsDoc(),
    );
  });
});
