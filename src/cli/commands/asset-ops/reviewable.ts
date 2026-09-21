import { type StageDefinitions, isDeterministicAddress } from "../../../core/definition-hashes.js";
import { KonteError } from "../../../core/errors.js";

// A dismissal decides against one take in favour of another, so it needs takes to decide between.
export function assertDismissable(definitions: StageDefinitions, address: string): void {
  if (!isDeterministicAddress(definitions, address)) return;
  throw new KonteError(
    "DETERMINISTIC_NOT_DISMISSABLE",
    `Cannot decide against "${address}": a deterministic asset has one outcome, so there is no ` +
      `other take to decide for — edit its definition and re-run \`konte generate\``,
  );
}
