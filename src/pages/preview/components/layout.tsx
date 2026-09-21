import type React from "react";
import type { PreviewState } from "../types.js";

export function Layout({
  state,
  children,
}: {
  state: PreviewState | null;
  children: React.ReactNode;
}): React.ReactElement {
  // The stage alone — the whole app is a review, so saying so in every title is noise.
  const title =
    state?.mode === "video-preview"
      ? "Video"
      : state?.mode === "animatic-preview"
        ? "Animatic"
        : state?.mode === "reference-preview"
          ? "Reference"
          : state?.mode === "direction-preview"
            ? "Direction"
            : "Preview";

  return (
    <div className="app">
      <header className="header">
        {/* The bar spans full width; its content is centred to the same column as <main>. */}
        <div className="header-inner">
          <div className="header-left">
            <img className="header-logo" src="/icon.png" alt="konte" />
            <span className="header-brand">konte</span>
            <span className="header-divider" />
            <span className="header-title">{title}</span>
          </div>
          <div className="header-info">
            {/* Per-view controls (e.g. the video review's toggles) portal in here. */}
            <div id="header-actions" className="header-actions" />
          </div>
        </div>
      </header>
      <main className="main-content">{children}</main>
    </div>
  );
}
