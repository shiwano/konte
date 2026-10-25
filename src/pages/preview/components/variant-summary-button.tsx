import type React from "react";
import type { VariantInfo } from "../types.js";
import { isNewVariant } from "../review/new-variant.js";
import { CheckIcon, GridIcon } from "./icons.js";

/**
 * Visual-only label: the variant count plus new/accepted signals at a
 * glance. Carries no wrapper or click behavior so it can be dropped into any
 * trigger — a frame action, or the video track lane.
 *
 * `compact` drops the words next to the counts (a timeline clip has only a few
 * pixels to spare), leaving icon + number; the titles carry the meaning.
 */
export function VariantSummaryLabel({
  variants,
  compact,
}: {
  variants: VariantInfo[];
  compact?: boolean;
}): React.ReactElement {
  const newCount = variants.filter(isNewVariant).length;
  const accepted = variants.some((v) => v.variantStatus === "accepted");

  return (
    <>
      <span className="variant-summary-icon">
        <GridIcon size={compact ? 11 : 13} />
      </span>
      <span
        className="variant-summary-count"
        title={compact ? `${variants.length} takes` : undefined}
      >
        {compact ? variants.length : `${variants.length} take${variants.length === 1 ? "" : "s"}`}
      </span>
      {newCount > 0 && (
        <span
          className="variant-summary-tag variant-summary-tag--new"
          title="Not yet accepted or dismissed"
        >
          {newCount} new
        </span>
      )}
      {accepted && (
        <span className="variant-summary-tag variant-summary-tag--accepted" title="accepted">
          <CheckIcon size={11} />
        </span>
      )}
    </>
  );
}
