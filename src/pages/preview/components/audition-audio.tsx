import type React from "react";
import { useEffect, useRef } from "react";

let context: AudioContext | null = null;
const gainNodes = new WeakMap<HTMLMediaElement, GainNode>();

// The gain rides a Web Audio node, leaving the element's volume to the reviewer's controls. Routed
// on first play, which is also the gesture an AudioContext needs.
function route(el: HTMLMediaElement): GainNode {
  const existing = gainNodes.get(el);
  if (existing) return existing;
  context ??= new AudioContext();
  const node = context.createGain();
  context.createMediaElementSource(el).connect(node).connect(context.destination);
  gainNodes.set(el, node);
  return node;
}

/** An `<audio>` playing a take at `gain` (linear), so takes are compared at one loudness. */
export function AuditionAudio({
  gain = 1,
  ...props
}: React.AudioHTMLAttributes<HTMLAudioElement> & { gain?: number }): React.ReactElement {
  const ref = useRef<HTMLAudioElement>(null);
  const gainRef = useRef(gain);
  gainRef.current = gain;

  useEffect(() => {
    const el = ref.current;
    const node = el ? gainNodes.get(el) : undefined;
    if (node) node.gain.value = gain;
  }, [gain]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onPlay = () => {
      if (gainRef.current === 1 && !gainNodes.has(el)) return;
      try {
        route(el).gain.value = gainRef.current;
        void context?.resume();
      } catch {
        // Unroutable: the take plays at its own level.
      }
    };
    el.addEventListener("play", onPlay);
    return () => el.removeEventListener("play", onPlay);
  }, []);

  return (
    <audio ref={ref} {...props}>
      <track kind="captions" />
    </audio>
  );
}
