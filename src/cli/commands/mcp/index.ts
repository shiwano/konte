import { type Command, Option } from "commander";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("MCP server");

  declareScope(
    mcp
      .command("serve")
      .description("Start MCP server (stdio transport)")
      // Run by a `konte job wait` that found no daemon in the workspace.
      .addOption(new Option("--attached").hideHelp())
      .action(async (opts: { attached?: boolean }) => {
        const { startMcpServer } = await import("../../../mcp/index.js");
        await startMcpServer(requireWorkspaceRoot(), { attached: opts.attached === true });
      }),
    // The daemon watches every video in the workspace, so it needs no video of its own. It must
    // start instantly and write nothing to stdout (that stream is the MCP transport), so it opts
    // out of both the template sync and the type-check.
    { scope: "workspace", skipSync: true, skipTypeCheck: true },
  );

  // Run by an exiting daemon, detached into its own session (see daemon-exit.ts).
  declareScope(
    mcp.command("close-deployments", { hidden: true }).action(async () => {
      const { closeDeploymentsOnDaemonExit } = await import("../../../comfy-api/daemon-exit.js");
      await closeDeploymentsOnDaemonExit(requireWorkspaceRoot(), () => {});
    }),
    { scope: "workspace", skipSync: true, skipTypeCheck: true },
  );
}
