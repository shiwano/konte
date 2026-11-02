import { type SuggestedAction, formatSuggestedActions } from "../core/suggested-actions.js";

export function printNextSteps(actions: readonly SuggestedAction[]): void {
  if (actions.length === 0) return;
  console.log(`\n${formatSuggestedActions(actions)}`);
}
