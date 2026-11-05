import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HyperFramesPlayerRef } from "../components/hyperframes-player-wrapper.js";
import type { NoteDraft } from "../components/target-panel.js";
import type { ShotInfo } from "../types.js";
import { Playhead } from "./playhead.js";

type LoopMode = "off" | "all" | "shot";

// How much of the reel either side of a span `playSpan` plays.
const SPAN_PAD_SEC = 0.5;

export function findShotIdxAtTime(shots: ShotInfo[], time: number): number {
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    if (time >= s.startTime && time < s.startTime + s.duration) return i;
  }
  return shots.length > 0 ? shots.length - 1 : -1;
}

/**
 * The reel's transport: the playhead, the shot it is in, play / pause, seeking, looping and speed.
 * An open note draft follows the playhead and holds the reel still.
 */
export function useReelPlayback({
  shots,
  totalDuration,
  fps,
  noteDraft,
  setNoteDraft,
}: {
  shots: ShotInfo[];
  totalDuration: number;
  fps: number;
  noteDraft: NoteDraft | null;
  setNoteDraft: React.Dispatch<React.SetStateAction<NoteDraft | null>>;
}) {
  // Playback reports a new time ~30×/s. It lives outside React state so only the leaves that
  // show it (the clock, the playhead line, the note overlay) redraw with it; the shot the
  // playhead is *in* changes rarely, so that stays ordinary state.
  const [playhead] = useState(() => new Playhead());
  const [focusedShotIdx, setFocusedShotIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>("off");
  const [playbackRate, setPlaybackRate] = useState(1);

  const playerRef = useRef<HyperFramesPlayerRef>(null);
  const playbackRateRef = useRef(1);
  // Read by the player's frame reports, which must not pull the review into a re-render per frame.
  const noteDraftRef = useRef<NoteDraft | null>(null);
  noteDraftRef.current = noteDraft;
  // Where a span being played stops.
  const stopAtRef = useRef<number | null>(null);

  // A definition reload can shrink the timeline out from under the focused index.
  useEffect(() => {
    setFocusedShotIdx((i) => Math.min(i, Math.max(shots.length - 1, 0)));
  }, [shots]);

  const handleTimeUpdate = useCallback(
    (time: number) => {
      playhead.set(time);
      setFocusedShotIdx(findShotIdxAtTime(shots, time));
      // The panel names the shot at this instant, so an open composer moves with it whatever put
      // the playhead here — a frame step, the player settling a seek onto its own 30fps grid, a
      // reload resuming. Both sides then read one time, so a note cannot file off the shot shown.
      const draft = noteDraftRef.current;
      if (draft && draft.time !== time) setNoteDraft({ ...draft, time });
      // A span being played ends where it ends, whatever the loop says.
      const stopAt = stopAtRef.current;
      if (stopAt !== null) {
        if (time >= stopAt) {
          stopAtRef.current = null;
          playerRef.current?.pause();
          setIsPlaying(false);
        }
        return;
      }
      // A loop restart would undo the pause the composer opened with and carry a half-typed
      // note off its shot, so the reel holds still while one is being written.
      if (draft) return;
      if (loopMode === "all" && time >= totalDuration - 0.05) {
        playerRef.current?.seek(0);
        playerRef.current?.play();
      } else if (loopMode === "shot") {
        // Loop whichever shot the playhead is currently in; checking 0.05s before
        // its end keeps findShotIdxAtTime on the right shot at the boundary.
        const shot = shots[findShotIdxAtTime(shots, time)];
        if (shot && time >= shot.startTime + shot.duration - 0.05) {
          playerRef.current?.seek(shot.startTime);
          playerRef.current?.play();
        }
      }
    },
    [playhead, loopMode, totalDuration, shots, setNoteDraft],
  );

  const pausePlayback = useCallback(() => {
    stopAtRef.current = null;
    playerRef.current?.pause();
    setIsPlaying(false);
  }, []);

  // Play the reel over [start, end], a little either side, and stop.
  const playSpan = useCallback(
    ([start, end]: readonly [number, number]) => {
      const from = Math.max(0, start - SPAN_PAD_SEC);
      playerRef.current?.seek(from);
      playhead.set(from);
      setFocusedShotIdx(findShotIdxAtTime(shots, from));
      // Short of the end, which the player may never report reaching.
      stopAtRef.current = Math.min(end + SPAN_PAD_SEC, totalDuration - 0.05);
      playerRef.current?.play();
      setIsPlaying(true);
    },
    [playhead, shots, totalDuration],
  );

  const handleSeek = useCallback(
    (time: number) => {
      stopAtRef.current = null;
      playerRef.current?.seek(time);
      playhead.set(time);
      setFocusedShotIdx(findShotIdxAtTime(shots, time));
      // Moving the playhead on purpose is the reviewer saying they now mean this frame, so an
      // open composer follows — and drops a pin left on the frame it was placed on. Without
      // this the note keeps the instant it opened at and files to the shot left behind.
      setNoteDraft((draft) => (draft ? { time, pin: null } : null));
    },
    [playhead, shots, setNoteDraft],
  );

  const handleStepFrame = useCallback(
    (delta: number) => {
      stopAtRef.current = null;
      setIsPlaying(false);
      playerRef.current?.stepFrame(delta);
      // Stepping is a deliberate move off the frame a pin was placed on; the instant follows in
      // handleTimeUpdate, once the player reports where it landed.
      setNoteDraft((draft) => (draft?.pin ? { ...draft, pin: null } : draft));
    },
    [setNoteDraft],
  );

  // Arrow-key seek: one frame per press, so a tap nudges and a held key repeats at the OS
  // key-repeat rate into a smooth ~1× scrub. Each repeat steps off the live playhead, which the
  // store updates synchronously — reading a rendered value would make every repeat in a burst
  // seek from the same stale instant.
  const handleArrowSeek = useCallback(
    (direction: -1 | 1) => {
      if (isPlaying) {
        playerRef.current?.pause();
        setIsPlaying(false);
      }
      const next = Math.min(Math.max(playhead.get() + direction / fps, 0), totalDuration);
      handleSeek(next);
    },
    [playhead, isPlaying, fps, totalDuration, handleSeek],
  );

  // Apply playback rate live; re-applied on composition reload via handlePlayerReady.
  useEffect(() => {
    playbackRateRef.current = playbackRate;
    playerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  const handlePlayerReady = useCallback(() => {
    playerRef.current?.setPlaybackRate(playbackRateRef.current);
  }, []);

  const handlePlayPause = useCallback(() => {
    stopAtRef.current = null;
    if (isPlaying) {
      playerRef.current?.pause();
      setIsPlaying(false);
    } else {
      if (playhead.get() >= totalDuration - 0.25) {
        playerRef.current?.seek(0);
        playhead.set(0);
        setFocusedShotIdx(0);
      }
      playerRef.current?.play();
      setIsPlaying(true);
    }
  }, [playhead, isPlaying, totalDuration]);

  return {
    playhead,
    playerRef,
    focusedShotIdx,
    isPlaying,
    setIsPlaying,
    loopMode,
    setLoopMode,
    playbackRate,
    setPlaybackRate,
    handleTimeUpdate,
    handlePlayerReady,
    pausePlayback,
    handleSeek,
    handleStepFrame,
    handleArrowSeek,
    handlePlayPause,
    playSpan,
  };
}
