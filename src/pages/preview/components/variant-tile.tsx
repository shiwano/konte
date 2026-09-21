import type React from "react";
import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../format-time.js";
import type { MediaKind, VariantInfo } from "../types.js";
import { CheckIcon, InfoIcon, VolumeIcon } from "./icons.js";

// Touch/pen devices have no hover, so a hover-gated <video> would never play
// there (tablet review). On those devices fall back to "play while on-screen";
// mouse devices keep the hover gate so idle cost stays ≈ an image grid.
const CANNOT_HOVER =
  typeof window !== "undefined" && !!window.matchMedia?.("(hover: none)").matches;

// Badge text where the state's name is not what a reviewer should read on a tile.
const BADGE_LABELS: Record<string, string> = { dismissed: "not used" };

/**
 * One variant in the gallery grid. Animatic variants render as a static image;
 * video variants show their first-frame poster and only mount a real <video>
 * (muted loop) while hovered and on-screen, keeping the idle cost ≈ an image grid
 * even with many variants. Audio variants have no poster, so they render a glyph
 * plus a native <audio> control for auditioning each take. Clicking the media opens the variant
 * detail overlay; "Use" is its own button, so picking a take never rides on a click meant to look
 * at it.
 */
export function VariantTile({
  variant,
  kind,
  selected,
  onOpen,
  onUse,
  onOpenInfo,
}: {
  variant: VariantInfo;
  kind: MediaKind;
  selected: boolean;
  onOpen: () => void;
  onUse: () => void;
  // Opens the declaration this take was generated from.
  onOpenInfo?: () => void;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Comparison only. The tile still stands for the patched take — "Use" keeps pointing at it —
  // because the take underneath is a "before", not a rival candidate to switch to.
  const [showBefore, setShowBefore] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin: "100px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const before = variant.before ?? null;
  const viewingBefore = showBefore && before !== null;
  const badge = viewingBefore
    ? "before"
    : variant.variantStatus === "accepted"
      ? "accepted"
      : variant.stale
        ? "stale"
        : variant.dismissed
          ? "dismissed"
          : before
            ? "patched"
            : variant.isNew
              ? "new"
              : null;
  // Only staleness dims a tile: a dismissed take is intact media, and its badge carries the
  // verdict.
  const deemphasized = variant.stale;
  const isAudio = kind === "audio";
  const shownImageUrl = viewingBefore ? before.imageUrl : variant.imageUrl;
  const shownFileUrl = viewingBefore ? (before.fileUrl ?? null) : variant.fileUrl;
  const showVideo = kind === "video" && (hovered || CANNOT_HOVER) && inView && !!shownFileUrl;

  const cls = [
    "variant-tile",
    selected ? "variant-tile--selected" : "",
    deemphasized ? "variant-tile--deemphasized" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={rootRef}
      className={cls}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`variant-tile-media${isAudio ? " variant-tile-media--audio" : ""}`}
        title={`Open ${variant.variantId}`}
        onClick={onOpen}
      >
        {isAudio ? (
          <span className="variant-tile-audio-glyph">
            <VolumeIcon size={28} />
          </span>
        ) : shownImageUrl ? (
          <img className="variant-tile-img" src={shownImageUrl} alt={variant.variantId} />
        ) : (
          <span className="variant-tile-empty">?</span>
        )}
        {showVideo && (
          <video
            className="variant-tile-video"
            src={shownFileUrl ?? undefined}
            poster={shownImageUrl ?? undefined}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
          />
        )}
        {badge && (
          <span className={`animatic-variant-thumb-badge animatic-variant-thumb-badge--${badge}`}>
            {BADGE_LABELS[badge] ?? badge}
          </span>
        )}
        {selected && (
          <span className="variant-tile-using">
            <CheckIcon size={10} /> Using
          </span>
        )}
      </button>
      {isAudio && shownFileUrl && (
        <audio className="variant-tile-audio" src={shownFileUrl} controls preload="none">
          <track kind="captions" />
        </audio>
      )}
      <div className="variant-tile-actions">
        <button
          type="button"
          className="variant-tile-id"
          title={`Copy ${variant.variantId}`}
          onClick={() => {
            void navigator.clipboard?.writeText(variant.variantId).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "copied" : variant.variantId}
        </button>
        {variant.turbo && (
          <span
            className="variant-tile-turbo"
            title="The first take, generated on the model's fast setting. The next take uses its full one."
          >
            turbo
          </span>
        )}
        {before && (
          <button
            type="button"
            className={`variant-tile-before${viewingBefore ? " variant-tile-before--on" : ""}`}
            title={
              viewingBefore
                ? `Showing ${before.variantId} (before the patch)`
                : `Show ${before.variantId} (before the patch)`
            }
            aria-pressed={viewingBefore}
            onClick={() => setShowBefore((v) => !v)}
          >
            before
          </button>
        )}
        {variant.createdAt && (
          <span className="variant-tile-age" title={variant.createdAt}>
            {formatRelativeTime(variant.createdAt)}
          </span>
        )}
        {onOpenInfo && (
          <button
            type="button"
            className="variant-tile-info"
            title="What this take was generated from: prompt and inputs"
            aria-label="Asset info"
            onClick={onOpenInfo}
          >
            <InfoIcon size={13} />
          </button>
        )}
        <button
          type="button"
          className={`variant-tile-use${selected ? " variant-tile-use--on" : ""}`}
          title={selected ? `Already using ${variant.variantId}` : `Use ${variant.variantId}`}
          aria-pressed={selected}
          disabled={selected}
          onClick={onUse}
        >
          {selected ? "Using" : "Use"}
        </button>
      </div>
    </div>
  );
}
