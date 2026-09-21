import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchState } from "./api.js";
import { VideoPreview } from "./components/video-preview.js";
import { DirectionPreview } from "./components/direction-preview.js";
import { Layout } from "./components/layout.js";
import { ReferencePreview } from "./components/reference-preview.js";
import type { DirectionPreviewState, PreviewState, ReferencePreviewState } from "./types.js";

type BannerInfo = { type: "reload" | "error" | "update" | "ended"; message: string };

export function App(): React.ReactElement {
  const [state, setState] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerInfo | null>(null);

  // Reloads overlap (a hot-reload landing while the reviewer hits the update banner), and the
  // slower response is not always the older one — abort the in-flight fetch so only the newest
  // request can settle into state.
  const stateFetchRef = useRef<AbortController | null>(null);
  const loadState = useCallback(() => {
    stateFetchRef.current?.abort();
    const controller = new AbortController();
    stateFetchRef.current = controller;
    fetchState(controller.signal)
      .then(setState)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    loadState();
    return () => stateFetchRef.current?.abort();
  }, [loadState]);

  useEffect(() => {
    function handleReload() {
      loadState();
      setBanner({ type: "reload", message: "✓ Definition reloaded" });
    }

    function handleError(e: Event) {
      const detail = (e as CustomEvent).detail as { error: string };
      setBanner({ type: "error", message: detail.error });
    }

    // The window closes itself on this; the banner is what a browser that refuses to close shows
    // instead, so the page is not left looking live over a server that has gone.
    function handleSessionEnded() {
      setBanner({ type: "ended", message: "Preview session ended. you can close this window" });
    }

    window.addEventListener("konte:reload", handleReload);
    window.addEventListener("konte:error", handleError);
    window.addEventListener("konte:session-ended", handleSessionEnded);
    return () => {
      window.removeEventListener("konte:reload", handleReload);
      window.removeEventListener("konte:error", handleError);
      window.removeEventListener("konte:session-ended", handleSessionEnded);
    };
  }, [loadState]);

  // A background watcher committing a new variant (reroll/accept/generation)
  // rewrites the state file. Surface a persistent prompt rather than refetching
  // mid-review — an unannounced swap would interrupt playback and shift the grid
  // under the reviewer. They refresh at a natural break via the banner's action.
  const submittingRef = useRef(false);
  useEffect(() => {
    function handleSubmitting() {
      submittingRef.current = true;
    }
    function handleStateChanged() {
      if (submittingRef.current) return;
      setBanner({ type: "update", message: "New variants available" });
    }
    window.addEventListener("konte:submitting", handleSubmitting);
    window.addEventListener("konte:state-changed", handleStateChanged);
    return () => {
      window.removeEventListener("konte:submitting", handleSubmitting);
      window.removeEventListener("konte:state-changed", handleStateChanged);
    };
  }, []);

  const applyStateUpdate = useCallback(() => {
    loadState();
    setBanner(null);
  }, [loadState]);

  useEffect(() => {
    // Only the transient "reloaded" confirmation auto-dismisses; error and the
    // update prompt stay until the reviewer acts.
    if (banner?.type !== "reload") return;
    const timer = setTimeout(() => setBanner(null), 3000);
    return () => clearTimeout(timer);
  }, [banner]);

  if (error && !state) {
    return (
      <Layout state={null}>
        <div className="error-message">{error}</div>
      </Layout>
    );
  }

  if (!state) {
    return (
      <Layout state={null}>
        <div className="loading">Loading...</div>
      </Layout>
    );
  }

  function renderContent() {
    switch (state!.mode) {
      // One page for both composition stages — a reel of shots, played through.
      case "video-preview":
      case "animatic-preview":
        return <VideoPreview state={state!} />;
      case "reference-preview":
        return <ReferencePreview state={state! as ReferencePreviewState} />;
      case "direction-preview":
        return <DirectionPreview state={state! as DirectionPreviewState} />;
    }
  }

  return (
    <Layout state={state}>
      {banner && (
        <div className={`hot-reload-banner hot-reload-banner--${banner.type}`}>
          <span>{banner.message}</span>
          {banner.type === "update" && (
            <div className="hot-reload-banner-actions">
              <button className="hot-reload-banner-action" onClick={applyStateUpdate}>
                Reload
              </button>
              <button className="hot-reload-banner-dismiss" onClick={() => setBanner(null)}>
                ✕
              </button>
            </div>
          )}
          {banner.type === "error" && (
            <button className="hot-reload-banner-dismiss" onClick={() => setBanner(null)}>
              ✕
            </button>
          )}
        </div>
      )}
      {error && <div className="error-message">{error}</div>}
      {renderContent()}
    </Layout>
  );
}
