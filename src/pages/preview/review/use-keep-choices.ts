import { useCallback, useRef, useState } from "react";
import {
  type KeepChoice,
  type KeepDecision,
  type KeepPromptEntry,
  keepingUnit,
  withoutUnits,
} from "./keep-or-regenerate.js";

/**
 * The session's Keep-or-regenerate answers and the one prompt open at a time.
 *
 * `request` settles an accept of the `origins` units: with no entry it applies the accept at once;
 * otherwise it applies it once answered, with the answers, and not at all on Cancel.
 * Either way through, the origins are decided again, so every earlier answer about them goes
 * (`withoutUnits`).
 */
export function useKeepChoices() {
  const [choices, setChoices] = useState<KeepChoice[]>([]);
  const [asking, setAsking] = useState<{
    entries: KeepPromptEntry[];
    origins: readonly string[];
    apply: () => void;
  } | null>(null);
  const seq = useRef(0);

  const request = useCallback(
    (entries: KeepPromptEntry[], apply: () => void, origins: readonly string[]) => {
      if (entries.length > 0) {
        setAsking({ entries, origins, apply });
        return;
      }
      setChoices((prev) => withoutUnits(prev, origins));
      apply();
    },
    [],
  );

  // The answer per row, by unit; a row not named keeps.
  const answer = useCallback(
    (decisions: Record<string, KeepDecision> | null) => {
      if (!asking) return;
      setAsking(null);
      if (decisions === null) return;
      setChoices((prev) => [
        ...withoutUnits(prev, asking.origins),
        ...asking.entries.map((entry) => ({
          ...entry,
          seq: ++seq.current,
          targets: entry.targets.map((t) => ({ ...t, decision: decisions[t.unit] ?? "keep" })),
        })),
      ]);
      asking.apply();
    },
    [asking],
  );

  // A unit taken back, or shown another take, is decided again.
  const dropUnits = useCallback((units: readonly string[]) => {
    setChoices((prev) => withoutUnits(prev, units));
  }, []);

  // A Regenerate taken back from the list: the row keeps after all.
  const keepUnit = useCallback((unit: string) => {
    setChoices((prev) => keepingUnit(prev, unit));
  }, []);

  const reset = useCallback(() => {
    setChoices([]);
    setAsking(null);
  }, []);

  return { choices, asking, request, answer, dropUnits, keepUnit, reset };
}
