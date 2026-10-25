// The variant gallery's tabs for one review target: the assets with takes, in the order the
// timeline stacks them — a shot's Video clips, then its Image clips, then its audio cues, each by
// start time; the soundtrack's beds by start time.

interface TabClip {
  address: string | null;
  mediaType: "video" | "image" | "audio";
  start: number;
}

interface TabShot {
  shotId: string;
  assets: ReadonlyArray<{ address: string; variants: readonly unknown[] }>;
  clips: readonly TabClip[];
}

interface TabAudioAsset {
  address: string;
  kind: "sound" | "soundtrack";
  variants: readonly unknown[];
  cues: ReadonlyArray<{ start: number; shotId?: string | null }>;
}

function inStartOrder(entries: Array<{ address: string; start: number }>): string[] {
  const out: string[] = [];
  for (const { address } of [...entries].sort((a, b) => a.start - b.start)) {
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

export function shotGalleryTabs(shot: TabShot, audioAssets: readonly TabAudioAsset[]): string[] {
  const visual = (mediaType: "video" | "image") =>
    inStartOrder(
      shot.clips.flatMap((c) => {
        if (c.mediaType !== mediaType || c.address === null) return [];
        const asset = shot.assets.find((a) => a.address === c.address);
        return asset && asset.variants.length > 0 ? [{ address: c.address, start: c.start }] : [];
      }),
    );
  const audio = inStartOrder(
    audioAssets.flatMap((a) =>
      a.kind === "sound" && a.variants.length > 0
        ? a.cues
            .filter((c) => c.shotId === shot.shotId)
            .map((c) => ({ address: a.address, start: c.start }))
        : [],
    ),
  );
  return [...visual("video"), ...visual("image"), ...audio];
}

export function soundtrackGalleryTabs(audioAssets: readonly TabAudioAsset[]): string[] {
  return inStartOrder(
    audioAssets.flatMap((a) =>
      a.kind === "soundtrack" && a.variants.length > 0
        ? a.cues.map((c) => ({ address: a.address, start: c.start }))
        : [],
    ),
  );
}
