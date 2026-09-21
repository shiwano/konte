import { useSyncExternalStore } from "react";

/**
 * The playhead, held outside React. Playback reports a new time ~30×/s; routing that through
 * component state would re-render the whole review (timeline, shot list, comments) on every
 * frame. The store lets only the leaves that actually show time subscribe — the rest re-render
 * on real review state (accepts, notes, takes) alone.
 */
export class Playhead {
  private time = 0;
  private listeners = new Set<() => void>();

  set = (time: number): void => {
    if (time === this.time) return;
    this.time = time;
    for (const listener of this.listeners) listener();
  };

  get = (): number => this.time;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function usePlayheadTime(playhead: Playhead): number {
  return useSyncExternalStore(playhead.subscribe, playhead.get);
}
