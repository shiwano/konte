import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureTsc } from "../tsc-binary.js";
import { typeCheckWorkspace } from "../type-check.js";

vi.mock("../tsc-binary.js", () => ({ ensureTsc: vi.fn() }));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-type-check-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it("reports a compiler launch failure instead of inventing a type error", async () => {
  const missingCompiler = path.join(dir, "missing-tsc");
  vi.mocked(ensureTsc).mockResolvedValue(missingCompiler);
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");

  await expect(typeCheckWorkspace(dir, null)).rejects.toMatchObject({
    code: "TSC_SETUP_FAILED",
    message: expect.stringMatching(/tsc execution failed \(code: ENOENT\).*missing-tsc/s),
  });
});

it("preserves the location and message of compiler diagnostics", async () => {
  vi.mocked(ensureTsc).mockResolvedValue(path.resolve("node_modules/.bin/tsc"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ files: ["adapter.ts"] }));
  fs.writeFileSync(path.join(dir, "adapter.ts"), 'const value: number = "broken";');

  const result = await typeCheckWorkspace(dir, null);
  expect(result.success).toBe(false);
  expect(result.diagnostics).toContainEqual({
    file: "adapter.ts",
    line: 1,
    column: 7,
    code: "TS2322",
    message: "Type 'string' is not assignable to type 'number'.",
  });
  expect(result.output).toContain("adapter.ts");
  expect(result.output).toContain("TS2322");
});
