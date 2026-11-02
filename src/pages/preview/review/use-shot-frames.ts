import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShotInfo } from "../types.js";

type ShotFrames = { first: string | null; last: string | null };

// At most this many frame captures run at once. Each capture loads the whole clip into a
// hidden <video>, so the unbounded startup sweep decoded every clip on the timeline
// simultaneously — on a large project that is hundreds of concurrent full-file loads.
const CAPTURE_CONCURRENCY = 4;

function limitConcurrency(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * Grab the first and last frame of a video file client-side via a hidden <video>
 * element (same-origin, so the canvas isn't tainted). No server-side rendering.
 */
function captureFirstLastFrame(url: string): Promise<ShotFrames> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const canvas = document.createElement("canvas");
    const out: ShotFrames = { first: null, last: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore teardown errors
      }
      resolve(out);
    };
    const timer = setTimeout(finish, 8000);
    const grab = (): string | null => {
      try {
        if (!video.videoWidth) return null;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.7);
      } catch {
        return null;
      }
    };
    let stage: "first" | "last" = "first";
    const onSeeked = () => {
      if (stage === "first") {
        out.first = grab();
        stage = "last";
        const d = video.duration;
        const lastT = Number.isFinite(d) && d > 0.2 ? d - 0.1 : video.currentTime;
        if (lastT <= video.currentTime + 0.001) {
          out.last = out.first;
          finish();
        } else {
          video.currentTime = lastT;
        }
      } else {
        out.last = grab();
        finish();
      }
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener(
      "loadeddata",
      () => {
        video.currentTime = 0.04;
      },
      { once: true },
    );
    video.addEventListener("error", finish, { once: true });
    video.src = url;
  });
}

/**
 * Order the composition's <video> elements, keyed by file basename. `start` is
 * the konte <Video> `data-start` attribute (its timeline position — currently 0
 * by default, but specifiable in the future); `idx` is document order used as a
 * tiebreak. Ordering clips by (start, idx) yields timeline / authoring order.
 * Parsed via DOMParser (inert document: no script/resource loading).
 */
function parseVideoOrder(html: string): Map<string, { start: number; idx: number }> {
  const order = new Map<string, { start: number; idx: number }>();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("video").forEach((el, idx) => {
    const base = el.getAttribute("src")?.split("/").pop();
    const start = Number(el.getAttribute("data-start") ?? 0);
    if (base && !order.has(base)) order.set(base, { start, idx });
  });
  return order;
}

/** Each shot's first and last frame, of the takes the reel is playing. */
export function useShotFrames(
  shots: ShotInfo[],
  compositionHtml: string | null,
  effectiveVariants: Record<string, string>,
): Record<string, ShotFrames> {
  const [shotFrames, setShotFrames] = useState<Record<string, ShotFrames>>({});

  // Capturing a frame means loading the whole video file, so each URL is captured once and
  // remembered: switching one shot's take then re-captures that shot's clip alone, instead of
  // re-loading every video in the timeline.
  const frameCacheRef = useRef(new Map<string, Promise<ShotFrames>>());
  const captureCached = useCallback((url: string) => {
    const cached = frameCacheRef.current.get(url);
    if (cached) return cached;
    // Remember successes only. A capture that yielded nothing — a decode error, a file the server
    // hadn't written yet — is a transient failure, and caching it would leave that shot's strip
    // permanently blank for the rest of the session; evict so the next pass retries.
    const capture = captureFirstLastFrame(url).then((frames) => {
      if (!frames.first && !frames.last) frameCacheRef.current.delete(url);
      return frames;
    });
    frameCacheRef.current.set(url, capture);
    return capture;
  }, []);

  const videoOrder = useMemo(() => parseVideoOrder(compositionHtml ?? ""), [compositionHtml]);

  useEffect(() => {
    if (shots.length === 0) return;
    let cancelled = false;
    // Drop shots the reload removed; the rest are refreshed (from cache, mostly) below.
    setShotFrames((p) => {
      const live = Object.fromEntries(
        Object.entries(p).filter(([id]) => shots.some((s) => s.shotId === id)),
      );
      return Object.keys(live).length === Object.keys(p).length ? p : live;
    });
    (async () => {
      const FAR = { start: Number.MAX_SAFE_INTEGER, idx: Number.MAX_SAFE_INTEGER };
      const sortKey = (url: string) => videoOrder.get(url.split("/").pop() ?? "") ?? FAR;
      const limit = limitConcurrency(CAPTURE_CONCURRENCY);
      await Promise.allSettled(
        shots.map((shot) =>
          limit(async () => {
            if (cancelled) return;
            const videoUrls = shot.assets
              .filter((a) => a.mediaKind === "video")
              // Capture the variant the reviewer is actually seeing (matches the player), not
              // just the accepted one — so a shown reroll's frame is what the scrub preview uses.
              .map((a) => {
                const shownId = effectiveVariants[a.address] ?? a.variantId;
                return a.variants.find((v) => v.variantId === shownId)?.fileUrl ?? a.fileUrl;
              })
              .filter((u): u is string => !!u)
              .sort((a, b) => {
                const ka = sortKey(a);
                const kb = sortKey(b);
                return ka.start - kb.start || ka.idx - kb.idx;
              });
            // A shot that lost its video (a reload, or a take with no ready file) must lose its
            // scrub thumbnail too — the frames are no longer of anything on the timeline.
            if (videoUrls.length === 0) {
              if (!cancelled) {
                setShotFrames((p) => {
                  if (!(shot.shotId in p)) return p;
                  const next = { ...p };
                  delete next[shot.shotId];
                  return next;
                });
              }
              return;
            }
            const firstUrl = videoUrls[0]!;
            const lastUrl = videoUrls[videoUrls.length - 1]!;
            let frames: ShotFrames;
            if (firstUrl === lastUrl) {
              frames = await captureCached(firstUrl);
            } else {
              const [a, b] = await Promise.all([captureCached(firstUrl), captureCached(lastUrl)]);
              frames = { first: a.first, last: b.last };
            }
            if (!cancelled) setShotFrames((p) => ({ ...p, [shot.shotId]: frames }));
          }),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [shots, videoOrder, effectiveVariants, captureCached]);

  return shotFrames;
}
