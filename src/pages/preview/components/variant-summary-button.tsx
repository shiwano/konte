import type React from "react";
import type { VariantInfo } from "../types.js";
import { CheckIcon, GridIcon, StaleIcon } from "./icons.js";

/**
 * Visual-only label: the variant count plus accepted/stale signals at a
 * glance. Carries no wrapper or click behavior so it can be dropped into any
 * trigger — a frame action, or the video track lane.
 *
 * `compact` drops the words next to the counts (a timeline clip has only a few
 * pixels to spare), leaving icon + number; the titles carry the meaning.
 */
export function VariantSummaryLabel({
  variants,
  hasNewerVariant,
  compact,
}: {
  variants: VariantInfo[];
  hasNewerVariant?: boolean;
  compact?: boolean;
}): React.ReactElement {
  const accepted = variants.filter((v) => v.variantStatus === "accepted").length;
  const stale = variants.filter((v) => v.stale).length;

  return (
    <>
      <span className="variant-summary-icon">
        <GridIcon size={compact ? 11 : 13} />
      </span>
      <span
        className="variant-summary-count"
        title={compact ? `${variants.length} variants` : undefined}
      >
        {compact
          ? variants.length
          : `${variants.length} variant${variants.length === 1 ? "" : "s"}`}
      </span>
      {hasNewerVariant && (
        <span
          className="variant-summary-tag variant-summary-tag--new"
          title="A newer variant is ready. Open to review and accept it"
        >
          new
        </span>
      )}
      {accepted > 0 && (
        <span className="variant-summary-tag variant-summary-tag--accepted" title="accepted">
          <CheckIcon size={11} /> {accepted}
        </span>
      )}
      {stale > 0 && (
        <span className="variant-summary-tag variant-summary-tag--stale" title="stale">
          {compact ? <StaleIcon size={11} /> : "stale"} {stale}
        </span>
      )}
    </>
  );
}
