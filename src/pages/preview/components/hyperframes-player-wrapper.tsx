import type React from "react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

// The embedded hyperframes runtime emits and consumes frame numbers on a fixed
// internal clock (its canonicalFps), independent of the project's fps. Frame <-> time
// conversions across the postMessage bridge must use this value, not the project fps,
// or the timeline playhead drifts out of sync with playback.
const RUNTIME_FPS = 30;

export interface HyperFramesPlayerRef {
  play(): void;
  pause(): void;
  seek(time: number): void;
  /** Pause and step by `delta` runtime frames (1/30s each) from the current frame. */
  stepFrame(delta: number): void;
  setMuted(muted: boolean): void;
  setPlaybackRate(rate: number): void;
}

interface HyperFramesPlayerWrapperProps {
  compositionHtml: string | null;
  // Project fps (accepted for callers); frame<->time conversion uses RUNTIME_FPS, not this.
  fps: number;
  width: number;
  height: number;
  scale?: number;
  // Where a freshly loaded composition resumes. A getter, not a value: the playhead lives outside
  // React, so reading it as a prop would redraw the player on every reported frame.
  getStartTime?: () => number;
  onReady?: () => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
  playerRef?: React.Ref<HyperFramesPlayerRef>;
}

export function HyperFramesPlayerWrapper({
  compositionHtml,
  width,
  height,
  scale = 1,
  getStartTime,
  onReady,
  onTimeUpdate,
  onPlayingChange,
  playerRef,
}: HyperFramesPlayerWrapperProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Every composition gets a fresh iframe. A srcdoc swap keeps the frame's window, so a state
  // message the outgoing document posted after the swap would pass for the new document's first,
  // and the resume seek would go to a document already gone.
  const [doc, setDoc] = useState({ html: compositionHtml, key: 0 });
  const [isReady, setIsReady] = useState(false);
  if (doc.html !== compositionHtml) {
    setDoc({ html: compositionHtml, key: doc.key + 1 });
    setIsReady(false);
  }
  const readyWindowRef = useRef<MessageEventSource | null>(null);
  // The frame a fresh document was sent to, until it reports having left its own first frame.
  const resumeFrameRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  const sendMessage = useCallback((action: string, payload?: Record<string, unknown>) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { source: "hf-parent", type: "control", action, ...payload },
      "*",
    );
  }, []);

  useImperativeHandle(
    playerRef,
    () => ({
      play() {
        sendMessage("play");
      },
      pause() {
        sendMessage("pause");
      },
      seek(time: number) {
        const frame = Math.round(time * RUNTIME_FPS);
        sendMessage("seek", { frame, seekMode: "commit" });
      },
      stepFrame(delta: number) {
        sendMessage("pause");
        const frame = Math.max(0, lastFrameRef.current + delta);
        sendMessage("seek", { frame, seekMode: "commit" });
      },
      setMuted(muted: boolean) {
        sendMessage("set-muted", { muted });
      },
      setPlaybackRate(rate: number) {
        sendMessage("set-playback-rate", { playbackRate: rate });
      },
    }),
    [sendMessage],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;

      const data = event.data;
      if (!data || data.source !== "hf-preview") return;

      if (data.type === "state") {
        if (readyWindowRef.current !== event.source) {
          readyWindowRef.current = event.source;
          setIsReady(true);
          const frame = Math.max(0, Math.round((getStartTime?.() ?? 0) * RUNTIME_FPS));
          resumeFrameRef.current = frame;
          sendMessage("seek", { frame, seekMode: "commit" });
          onReady?.();
        }
        // The runtime auto-stops at the end; surface its play state so callers can
        // keep their controls in sync instead of getting stuck "playing".
        onPlayingChange?.(!!data.isPlaying);
        const frame = data.frame ?? 0;
        if (resumeFrameRef.current !== null) {
          if (frame === 0 && resumeFrameRef.current !== 0) {
            lastFrameRef.current = resumeFrameRef.current;
            return;
          }
          resumeFrameRef.current = null;
        }
        lastFrameRef.current = frame;
        onTimeUpdate?.(frame / RUNTIME_FPS);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [getStartTime, onReady, onTimeUpdate, onPlayingChange, sendMessage]);

  const displayWidth = width * scale;
  const displayHeight = height * scale;

  return (
    <div
      className="player-wrapper"
      style={{
        width: displayWidth,
        height: displayHeight,
        position: "relative",
        overflow: "hidden",
        background: "#000",
        borderRadius: 4,
      }}
    >
      <iframe
        key={doc.key}
        ref={iframeRef}
        srcDoc={compositionHtml ?? undefined}
        style={{
          width,
          height,
          border: "none",
          transformOrigin: "top left",
          transform: scale !== 1 ? `scale(${scale})` : undefined,
        }}
        sandbox="allow-scripts allow-same-origin"
        title="Composition Preview"
      />
      {!isReady && compositionHtml && <div className="player-loading">Loading composition...</div>}
    </div>
  );
}
