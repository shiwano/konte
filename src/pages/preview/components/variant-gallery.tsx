import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { MediaKind, VariantInfo } from "../types.js";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons.js";
import { Modal } from "./modal.js";
import { VariantDetail } from "./variant-detail.js";
import { VariantSummaryLabel } from "./variant-summary-button.js";
import { VariantTile } from "./variant-tile.js";

export interface GalleryTab {
  address: string;
  assetName: string;
  variants: VariantInfo[];
}

/**
 * Full-screen overlay listing every variant of one asset as a grid of tiles (video tiles play on
 * hover). Reuses the `.variant-modal-*` backdrop/dialog shell. Each tile's "Use" sets the
 * composition override; clicking the tile itself opens that take full size in `VariantDetail`,
 * where video and audio play under real transport controls. Each tile carries the asset-info
 * button for its own take: each was generated from its own declaration.
 *
 * Given `tabs`, the gallery is the review target's: titled by `subject`, with one tab per asset of
 * the target and the shown asset's tab active.
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
  subject,
  tabs,
  activeTab,
  onSelectTab,
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
  subject?: string;
  tabs?: GalleryTab[];
  activeTab?: string;
  onSelectTab?: (address: string) => void;
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
        tabs ? (
          subject
        ) : (
          <>
            {label} · {variants.length} takes
          </>
        )
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
      {tabs && <GalleryTabs tabs={tabs} activeTab={activeTab} onSelectTab={onSelectTab} />}
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

// One line of tabs, scrolled sideways with its scrollbar hidden: the active tab is kept in view, and
// an edge with tabs beyond it fades out under a button that scrolls that way.
function GalleryTabs({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: GalleryTab[];
  activeTab?: string;
  onSelectTab?: (address: string) => void;
}): React.ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () =>
      setOverflow({
        start: el.scrollLeft > 0,
        end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    el.addEventListener("scroll", measure);
    measure();
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  const scroll = (direction: 1 | -1) => {
    const el = listRef.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className="variant-gallery-tabbar">
      <div
        ref={listRef}
        className={`variant-gallery-tabs${overflow.start ? " variant-gallery-tabs--fade-start" : ""}${
          overflow.end ? " variant-gallery-tabs--fade-end" : ""
        }`}
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            key={t.address}
            ref={t.address === activeTab ? activeTabRef : undefined}
            type="button"
            role="tab"
            aria-selected={t.address === activeTab}
            className={`variant-gallery-tab${t.address === activeTab ? " variant-gallery-tab--active" : ""}`}
            onClick={() => onSelectTab?.(t.address)}
          >
            <span className="variant-gallery-tab-name">{t.assetName}</span>
            <VariantSummaryLabel variants={t.variants} compact />
          </button>
        ))}
      </div>
      {overflow.start && (
        <button
          type="button"
          className="variant-gallery-tabs-scroll variant-gallery-tabs-scroll--start"
          aria-label="Scroll tabs left"
          onClick={() => scroll(-1)}
        >
          <ChevronLeftIcon size={14} />
        </button>
      )}
      {overflow.end && (
        <button
          type="button"
          className="variant-gallery-tabs-scroll variant-gallery-tabs-scroll--end"
          aria-label="Scroll tabs right"
          onClick={() => scroll(1)}
        >
          <ChevronRightIcon size={14} />
        </button>
      )}
    </div>
  );
}
