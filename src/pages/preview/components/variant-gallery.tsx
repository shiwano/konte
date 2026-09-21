import type React from "react";
import { useState } from "react";
import type { MediaKind, VariantInfo } from "../types.js";
import { Modal } from "./modal.js";
import { VariantDetail } from "./variant-detail.js";
import { VariantTile } from "./variant-tile.js";

/**
 * Full-screen overlay listing every variant of one asset as a grid of tiles (video tiles play on
 * hover). Reuses the `.variant-modal-*` backdrop/dialog shell. Each tile's "Use" sets the
 * composition override; clicking the tile itself opens that take full size in `VariantDetail`,
 * where video and audio play under real transport controls. Each tile carries the asset-info
 * button for its own take: each was generated from its own declaration.
 */
export function VariantGallery({
  label,
  kind,
  variants,
  selectedVariantId,
  onUse,
  onOpenInfo,
  infoOpen,
  onClose,
}: {
  label: string;
  kind: MediaKind;
  variants: VariantInfo[];
  selectedVariantId: string | null;
  onUse: (variantId: string) => void;
  onOpenInfo: (variantId: string) => void;
  // The info panel is stacked on top of this one, and owns Escape while it is.
  infoOpen?: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = detailId ? (variants.find((v) => v.variantId === detailId) ?? null) : null;

  return (
    // The gallery owns Escape only while nothing is stacked on it; otherwise the overlay on top
    // (detail, asset info) closes itself back to the grid.
    <Modal
      className="variant-gallery"
      escape={detail || infoOpen ? "off" : "always"}
      onClose={onClose}
      title={
        <>
          {label} · {variants.length} variants
        </>
      }
      after={
        detail && (
          <VariantDetail
            label={label}
            kind={kind}
            variant={detail}
            selected={detail.variantId === selectedVariantId}
            onUse={() => onUse(detail.variantId)}
            onClose={() => setDetailId(null)}
          />
        )
      }
    >
      <div className="variant-gallery-grid">
        {variants.map((v) => (
          <VariantTile
            key={v.variantId}
            variant={v}
            kind={kind}
            selected={v.variantId === selectedVariantId}
            onOpen={() => setDetailId(v.variantId)}
            onUse={() => onUse(v.variantId)}
            onOpenInfo={v.info ? () => onOpenInfo(v.variantId) : undefined}
          />
        ))}
      </div>
    </Modal>
  );
}
