import type React from "react";
import type { VariantInfo } from "../types.js";
import { FitIcon, InfoIcon } from "./icons.js";
import { VariantSummaryLabel } from "./variant-summary-button.js";

/**
 * Name badge + the frame's icon-only actions (variant list, asset info, enlarge), overlaid on a
 * panel or a reference asset's media. Actions render only when the frame has them.
 */
export function FrameOverlay({
  assetName,
  variants,
  hasNewerVariant,
  onOpenGallery,
  onOpenInfo,
  onEnlarge,
  enlargeTitle = "Enlarge",
}: {
  assetName: string;
  variants?: VariantInfo[];
  hasNewerVariant?: boolean;
  onOpenGallery?: () => void;
  onOpenInfo?: () => void;
  onEnlarge?: () => void;
  enlargeTitle?: string;
}): React.ReactElement {
  const hasVariants = !!variants && variants.length > 0 && !!onOpenGallery;
  return (
    <>
      <div className="review-frame-asset-overlay">{assetName}</div>
      {(hasVariants || onOpenInfo || onEnlarge) && (
        <div className="review-frame-actions">
          {hasVariants && (
            <button
              type="button"
              className="review-frame-action review-frame-action--variants"
              onClick={(e) => {
                e.stopPropagation();
                onOpenGallery();
              }}
              title="Variant list"
            >
              <VariantSummaryLabel variants={variants} hasNewerVariant={hasNewerVariant} />
            </button>
          )}
          {onOpenInfo && (
            <button
              type="button"
              className="review-frame-action"
              onClick={(e) => {
                e.stopPropagation();
                onOpenInfo();
              }}
              title="Prompt and inputs"
              aria-label="Prompt and inputs"
            >
              <InfoIcon size={15} />
            </button>
          )}
          {onEnlarge && (
            <button
              type="button"
              className="review-frame-action"
              onClick={(e) => {
                e.stopPropagation();
                onEnlarge();
              }}
              title={enlargeTitle}
              aria-label={enlargeTitle}
            >
              <FitIcon size={15} />
            </button>
          )}
        </div>
      )}
    </>
  );
}
