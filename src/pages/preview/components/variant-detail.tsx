import type React from "react";
import { useState } from "react";
import { formatRelativeTime } from "../format-time.js";
import type { MediaKind, VariantInfo } from "../types.js";
import { CheckIcon, VolumeIcon } from "./icons.js";
import { Modal } from "./modal.js";

function badgeOf(v: VariantInfo): string | null {
  if (v.variantStatus === "accepted") return "accepted";
  if (v.stale) return "stale";
  if (v.dismissed) return "dismissed";
  if (v.before) return "patched";
  if (v.isNew) return "new";
  return null;
}

/**
 * One variant at full size, overlaid on the gallery: a video or audio take under native
 * transport controls, an image enlarged. The grid tile is a thumbnail to pick from; this is
 * where the take is actually watched, and where "Use" is decided from what was just played.
 */
export function VariantDetail({
  label,
  kind,
  variant,
  selected,
  onUse,
  onClose,
}: {
  label: string;
  kind: MediaKind;
  variant: VariantInfo;
  selected: boolean;
  onUse: () => void;
  onClose: () => void;
}): React.ReactElement {
  const before = variant.before ?? null;
  const [showBefore, setShowBefore] = useState(false);
  const viewingBefore = showBefore && before !== null;
  const badge = viewingBefore ? "before" : badgeOf(variant);
  const imageUrl = viewingBefore ? before.imageUrl : variant.imageUrl;
  const fileUrl = viewingBefore ? (before.fileUrl ?? null) : variant.fileUrl;
  const shownId = viewingBefore ? before.variantId : variant.variantId;

  return (
    <Modal
      className="variant-detail"
      closeLabel="Back to gallery"
      onClose={onClose}
      title={
        <>
          {label} · <span className="variant-detail-id">{shownId}</span>
          {badge && (
            <span className={`variant-detail-badge variant-detail-badge--${badge}`}>{badge}</span>
          )}
          {variant.createdAt && (
            <span className="variant-detail-age" title={variant.createdAt}>
              {formatRelativeTime(variant.createdAt)}
            </span>
          )}
        </>
      }
      actions={
        <>
          {before && (
            <button
              type="button"
              className={`ctrl-btn${viewingBefore ? " ctrl-btn--active" : ""}`}
              title={`Show ${before.variantId} (before the patch)`}
              aria-pressed={viewingBefore}
              onClick={() => setShowBefore((v) => !v)}
            >
              before
            </button>
          )}
          <button
            type="button"
            className={`ctrl-btn${selected ? " ctrl-btn--active" : ""}`}
            onClick={onUse}
            disabled={selected}
          >
            <CheckIcon size={13} /> {selected ? "Using" : "Use this"}
          </button>
        </>
      }
    >
      <div className={`variant-detail-media variant-detail-media--${kind}`}>
        {kind === "audio" ? (
          fileUrl ? (
            <div className="variant-detail-audio">
              <span className="variant-detail-audio-glyph">
                <VolumeIcon size={48} />
              </span>
              <audio src={fileUrl} controls autoPlay preload="auto">
                <track kind="captions" />
              </audio>
            </div>
          ) : (
            <span className="variant-detail-empty">?</span>
          )
        ) : kind === "video" ? (
          fileUrl ? (
            <video
              key={fileUrl}
              src={fileUrl}
              poster={imageUrl ?? undefined}
              controls
              loop
              autoPlay
              playsInline
              preload="auto"
            />
          ) : (
            <span className="variant-detail-empty">?</span>
          )
        ) : imageUrl ? (
          <img src={imageUrl} alt={shownId} />
        ) : (
          <span className="variant-detail-empty">?</span>
        )}
      </div>
    </Modal>
  );
}
