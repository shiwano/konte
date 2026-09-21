import type { Command } from "commander";
import thirdPartyLicenses from "../../core/generated/third-party-licenses.md" with { type: "text" };
import { declareScope } from "../scope.js";

export function registerLicensesCommand(program: Command): void {
  const licenses = program
    .command("licenses")
    .description("Print the licenses of the third-party software bundled into konte")
    .action(async () => {
      // Over 100KB of license text outruns a pipe's buffer, and console.log returns before the
      // write drains.
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(thirdPartyLicenses, (err) => (err ? reject(err) : resolve()));
      });
    })
    .addHelpText(
      "after",
      `
konte ships as a single binary with its dependencies compiled in, and reproduces the licenses of
that bundled software here. konte itself is MIT-licensed.

Examples:
  konte licenses                         Print every bundled license in full
  konte licenses > THIRD_PARTY.md        Save them alongside a redistributed binary
`,
    );

  // Asking what a binary bundles must work before there is a workspace to ask from.
  declareScope(licenses, { scope: "none" });
}
