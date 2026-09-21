import type { Command } from "commander";
import { parseStageScope } from "../../../core/address.js";
import { KonteError } from "../../../core/errors.js";
import { loadDirectionIfPresent, loadVideoAndAnimatic } from "../../load-definition.js";
import { loadReference } from "../../../core/loader.js";
import { requireVideoRoot } from "../../context.js";

export function registerPreviewCommand(program: Command): void {
  program
    .command("preview <stage>")
    .description("Preview a stage in the browser (e.g. direction, reference, animatic, video)")
    .option("--port <port>", "Server port (default: 4649, or a free port if it is taken)")
    .option(
      "--host <address>",
      "Address to bind (default: 127.0.0.1; 0.0.0.0 also serves your local network)",
    )
    .option("--no-auto-close", "Disable auto-close when browser disconnects")
    .option("--tunnel", "Open a Cloudflare quick tunnel and print its public URL")
    .option(
      "--handoff <path>",
      "Handoff file to show (default: latest under review/<stage>/handoffs/)",
    )
    .addHelpText(
      "after",
      `
Opens the review page for one stage and blocks until the browser closes or a review is submitted.

The server binds loopback and admits only loopback names. To review on a phone over the same wifi,
bind the LAN with --host 0.0.0.0 (or set preview.host in konte.config.json). To review from
anywhere, --tunnel opens a Cloudflare quick tunnel to a public https URL, which lives exactly as
long as the command does. There is no setting for it: a public URL is opened only on a run that
asks for one. Neither route needs preview.allowedHosts — that is for a proxy you front the server
with yourself, which must pass the original Host through: one that rewrites it to a loopback name
presents every visitor as local, and local is the one route that is not asked for a PIN.

Every route that is not loopback asks for a 4-digit PIN, printed on the startup line and fresh each
session. Five wrong answers close the tunnel; guesses that keep coming after that end the session.

Examples:
  konte preview animatic              Review the board
  konte preview video --host 0.0.0.0  Also serve your local network, for a phone
  konte preview video --tunnel        Also serve a public URL, PIN-gated
`,
    )
    .action(
      async (
        scope: string,
        opts: {
          port?: string;
          host?: string;
          autoClose: boolean;
          handoff?: string;
          tunnel?: boolean;
        },
      ) => {
        const { stage } = parseStageScope(scope);
        const videoRoot = requireVideoRoot();
        // The page host, its bundled UI and the tunnel are the preview command's alone; loading
        // them here keeps them out of every other command's startup.
        const { launchPreview } = await import("./index.js");

        // Direction loads its own `direction.ts` — a structural, media-less review of the
        // arc, shots and characters.
        if (stage === "direction") {
          const direction = await loadDirectionIfPresent(videoRoot);
          if (!direction) {
            throw new KonteError(
              "ADDRESS_NOT_FOUND",
              "No direction.ts found in this project — nothing to preview for the direction stage.",
            );
          }
          await launchPreview({ ...opts, mode: "direction-preview" });
          return;
        }

        // Reference loads its own `reference.tsx` rather than the video file.
        if (stage === "reference") {
          await loadReference(videoRoot);
          await launchPreview({ ...opts, mode: "reference-preview" });
          return;
        }

        // Both stage pages stand on the board, so a missing or broken animatic.tsx is refused here.
        await loadVideoAndAnimatic(videoRoot);

        await launchPreview({
          ...opts,
          mode: stage === "animatic" ? "animatic-preview" : "video-preview",
        });
      },
    );
}
