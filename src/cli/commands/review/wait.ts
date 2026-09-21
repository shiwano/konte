import * as http from "node:http";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { parseNumberOption, parsePositiveInt } from "../../parse-option.js";
import { declareScope } from "../../scope.js";

const REVIEW_ID = /^r-[0-9A-Za-z]+$/;

export function registerReviewWaitCommand(review: Command): void {
  const command = review
    .command("wait <reviewId>")
    .description("Wait for an open review to end")
    .requiredOption("--port <port>", "Port the preview listens on")
    .option("--timeout <seconds>", "Stop waiting after this many seconds; the review stays open")
    .addHelpText(
      "after",
      `
Run the command konte preview prints under Next steps. Returns once the review is submitted or
closed, or once no preview answers there any more; the outcome is in the preview's own output.

Examples:
  konte review wait <reviewId> --port 4649                Wait for the review to end
  konte review wait <reviewId> --port 4649 --timeout 600  Give up after 10 minutes
`,
    )
    .action(async (id: string, opts: { port: string; timeout?: string }) => {
      if (!REVIEW_ID.test(id)) {
        throw new KonteError("INVALID_OPTION", `Not a review id: ${id}`);
      }
      const port = parseNumberOption("--port", opts.port, { integer: true, min: 1, max: 65535 })!;
      const timeoutMs = opts.timeout
        ? parsePositiveInt(opts.timeout, "--timeout") * 1000
        : undefined;

      const url = new URL(`http://127.0.0.1:${port}/api/review/${id}/wait`);
      if (!(await waitForServerGone(url, timeoutMs))) {
        console.log(
          `Review still open (stopped waiting — timeout reached)\n\nNext steps:\n  konte review wait ${id} --port ${port}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log("Review ended. Read the rest of the konte preview command's output.");
    });
  declareScope(command, { scope: "none" });
}

// node:http rather than fetch: no client-side timeout to cut a long review short, and no proxy
// setting to route a loopback request elsewhere. Any end but the timeout — the wait's answer, a
// refused or dropped connection, another run's server on the same port — means this review is over.
function waitForServerGone(url: URL, timeoutMs: number | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
      res.on("error", () => resolve(true));
    });
    req.on("error", () => resolve(true));
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        resolve(false);
        req.destroy();
      }, timeoutMs);
      req.on("close", () => clearTimeout(timer));
    }
  });
}
