import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSeamDoc } from "../seam-doc.js";

describe("docs/SEAMS.md", () => {
  it("matches what the checker answers over the seam fixtures", async () => {
    const onDisk = readFileSync(new URL("../../../docs/SEAMS.md", import.meta.url), "utf-8");
    expect(onDisk, "stale — run `bun run build:generate-seam-doc`").toBe(await renderSeamDoc());
  });
});
