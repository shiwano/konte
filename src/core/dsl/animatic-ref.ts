import { formatAssetPath, formatNarrationStemAddress, formatShotStemAddress } from "../address.js";
import { KonteError } from "../errors.js";
import { isRendering } from "../jsx-html.js";
import type { AnimaticDefinition } from "../types/animatic.js";
import type { MediaAsset, MediaKind, NarrationStem, ShotHandle } from "./builders.js";
import { makeMediaAsset } from "./builders.js";
import {
  getPatchContext,
  getShotContext,
  getTimelineContext,
  makeAddressPlaceholder,
} from "./shot-context.js";

/**
 * One animatic shot as `video.tsx` reaches it: its takes by name and kind, plus the `stem` konte
 * mixes from the shot's cues, which an audio-driven motion model takes, and the `narrationStem` it
 * mixes from the narration apart, which only `<Audio>` places.
 *
 * The board shot's own rendering is not reachable; a V2V route wants `#composition` rendered to video
 * first.
 *
 * Each accessor names the media kind it expects and is checked against what the shot actually
 * declared: an unknown name, a kind mismatch, or an undeveloped (pendingShot) target throws while the
 * definition loads.
 */
export interface AnimaticShotRef extends ShotHandle {
  readonly stem: MediaAsset<"audio">;
  readonly narrationStem: NarrationStem;
}

export interface AnimaticRef {
  shot(id: string): AnimaticShotRef;
}

// The declared media kind of every asset of every shot, captured as the stage was discovered — an
// AssetDefinition does not carry one (a comfy definition names only its workflow), so the accessors'
// kind check reads this instead.
export type AssetKindsByShot = ReadonlyMap<string, ReadonlyMap<string, MediaKind>>;

export function createAnimaticRef(
  definition: AnimaticDefinition,
  assetKindsByShot: AssetKindsByShot,
): AnimaticRef {
  const shotsById = new Map(definition.shots.map((s) => [s.id, s]));

  return {
    shot(id: string): AnimaticShotRef {
      // Only inside a build, or the render a function component's body runs in.
      if (!getShotContext() && !getTimelineContext() && !getPatchContext() && !isRendering()) {
        throw new KonteError(
          "ANIMATIC_INVALID",
          `animatic.shot("${id}") was called outside a build. Call it inside the timeline or a ` +
            `shot's build — a helper defined at module scope may call it, as long as it runs there.`,
        );
      }
      const shot = shotsById.get(id);
      if (!shot) {
        throw new KonteError(
          "ANIMATIC_INVALID",
          `animatic.shot("${id}"): the animatic declares no shot "${id}". ` +
            `Declared: ${[...shotsById.keys()].join(", ") || "(none)"}.`,
        );
      }
      if (shot.pending) {
        throw new KonteError(
          "ANIMATIC_INVALID",
          `animatic.shot("${id}"): animatic shot "${id}" is still an undeveloped pendingShot and ` +
            `declares nothing. Develop it (swap pendingShot for shot) before referencing it.`,
        );
      }
      const kinds = assetKindsByShot.get(id) ?? new Map<string, MediaKind>();
      // A keyframe backed by a SHARED asset — an `animatic:timeline.<name>` asset, a
      // `reference:<name>` image — is declared by the `<Panel>`, not by an `asset()` in this shot,
      // so it is not in `kinds`. It is still this shot's keyframe by that name, and the panel
      // recorded where it really lives, so the accessor resolves it there.
      const panelPaths = new Map(
        [...(shot.panels ?? []), ...(shot.cutin?.panels ?? [])]
          .filter((p) => !p.assetPath.startsWith(`animatic:shot.${id}.`))
          .map((p) => [p.assetName, p.assetPath] as const),
      );
      const get = <T extends MediaKind>(assetName: string, want: T): MediaAsset<T> => {
        const shared = panelPaths.get(assetName);
        if (shared !== undefined) {
          if (want !== "image") {
            throw new KonteError(
              "ANIMATIC_INVALID",
              `animatic.shot("${id}").${want}("${assetName}"): "${assetName}" is a keyframe, so it ` +
                `is an image. Use .image("${assetName}").`,
            );
          }
          return makeMediaAsset<T>(makeAddressPlaceholder(shared));
        }
        const found = kinds.get(assetName);
        if (found === undefined) {
          const names = [...kinds.keys(), ...panelPaths.keys()];
          throw new KonteError(
            "ANIMATIC_INVALID",
            `animatic.shot("${id}").${want}("${assetName}"): animatic shot "${id}" declares no ` +
              `asset named "${assetName}". Declared: ${names.join(", ") || "(none)"}.`,
          );
        }
        if (found !== want) {
          throw new KonteError(
            "ANIMATIC_INVALID",
            `animatic.shot("${id}").${want}("${assetName}"): animatic shot "${id}"'s asset ` +
              `"${assetName}" is ${found}, not ${want}. Use .${found}("${assetName}").`,
          );
        }
        return makeMediaAsset<T>(
          makeAddressPlaceholder(formatAssetPath("animatic", id, assetName)),
        );
      };
      return {
        video: (assetName) => get(assetName, "video"),
        image: (assetName) => get(assetName, "image"),
        audio: (assetName) => get(assetName, "audio"),
        get stem() {
          // The stem only exists once the shot has something to mix. Reaching for one that does not
          // would otherwise surface as a generic missing-reference at graph time, well away from the
          // line that asked for it.
          if ((shot.stemRefs?.length ?? 0) === 0) {
            throw new KonteError(
              "ANIMATIC_INVALID",
              (shot.narrationStemRefs?.length ?? 0) > 0
                ? `animatic.shot("${id}").stem: animatic shot "${id}" plays only narration, which ` +
                    `is not in its stem — nothing on screen speaks it. Drive the motion without a ` +
                    `stem, and place .narrationStem with <Audio>.`
                : `animatic.shot("${id}").stem: animatic shot "${id}" plays no audio, so it has ` +
                    `no stem. Place the shot's lines in animatic.tsx with <Audio>, or drop the ` +
                    `reference.`,
            );
          }
          return makeMediaAsset<"audio">(
            makeAddressPlaceholder(formatShotStemAddress("animatic", id)),
          );
        },
        get narrationStem() {
          if ((shot.narrationStemRefs?.length ?? 0) === 0) {
            throw new KonteError(
              "ANIMATIC_INVALID",
              `animatic.shot("${id}").narrationStem: animatic shot "${id}" plays no narration, so ` +
                `it has no narration stem. Drop the reference.`,
            );
          }
          return { src: makeAddressPlaceholder(formatNarrationStemAddress(id)) };
        },
      };
    },
  };
}
