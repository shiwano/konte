import { collectArcShots } from "../../../core/direction.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type { ScriptLine } from "../../../core/types/script.js";
import { IMAGED_VIEWS, viewAssetName } from "../../../core/view.js";
import type { ReferenceGroupInfo, ReferenceGroupMemberInfo } from "../../../pages/preview/types.js";

type Line = NonNullable<ReferenceGroupMemberInfo["lines"]>[number];

// The reference pool as the subjects the direction names, read off the rosters alone. A sample cast
// twice is a member of both groups.
export function referenceGroups(
  direction: Direction | null,
  exposedNames: readonly string[],
): ReferenceGroupInfo[] {
  const exposed = new Set(exposedNames);
  const claimed = new Set<string>();
  const groups: ReferenceGroupInfo[] = [];
  const member = (
    name: string,
    rest: Omit<ReferenceGroupMemberInfo, "address">,
  ): ReferenceGroupMemberInfo[] => {
    if (!exposed.has(name)) return [];
    claimed.add(name);
    return [{ address: `reference:${name}`, ...rest }];
  };
  const add = (group: ReferenceGroupInfo) => {
    if (group.members.length > 0) groups.push(group);
  };

  if (direction) {
    const script = collectArcShots(direction).flatMap((s) => s.script ?? []);
    const linesOf = (said: (line: ScriptLine) => Line | null): Line[] =>
      script.flatMap((line) => said(line) ?? []);

    for (const [id, c] of Object.entries(direction.characters ?? {})) {
      add({
        id: `character:${id}`,
        kind: "character",
        name: c.name,
        members: [
          ...member(id, { role: "look" }),
          ...(c.voice
            ? member(c.voice.id, {
                role: "voice",
                lines: linesOf((l) =>
                  "character" in l && l.character === id
                    ? { text: l.text, acting: l.acting ?? null }
                    : null,
                ),
              })
            : []),
        ],
      });
    }
    if (direction.narrator) {
      add({
        id: "narrator",
        kind: "narrator",
        name: "the narrator",
        members: member(direction.narrator.id, {
          role: "voice",
          lines: linesOf((l) => ("narration" in l ? { text: l.narration, acting: null } : null)),
        }),
      });
    }
    for (const [id, p] of Object.entries(direction.props ?? {})) {
      add({ id: `prop:${id}`, kind: "prop", name: p.name, members: member(id, { role: "look" }) });
    }
    for (const [id, l] of Object.entries(direction.locations ?? {})) {
      const holds = (ids: readonly string[] | undefined) =>
        (ids ?? []).map((landmark) => l.landmarks?.[landmark]?.name ?? landmark);
      add({
        id: `location:${id}`,
        kind: "location",
        name: l.name,
        members: [
          ...member(id, { role: "master", holds: holds(l.views?.front?.holds) }),
          ...IMAGED_VIEWS.flatMap((view) =>
            member(viewAssetName(id, view), {
              role: "view",
              view,
              holds: holds(l.views?.[view]?.holds),
            }),
          ),
        ],
      });
    }
    const song = direction.policy?.song;
    if (song !== undefined) {
      add({ id: "song", kind: "song", name: "the song", members: member(song, { role: "song" }) });
    }
  }

  for (const name of exposedNames) {
    if (claimed.has(name)) continue;
    groups.push({
      id: `material:${name}`,
      kind: "material",
      name,
      members: [{ address: `reference:${name}`, role: "material" }],
    });
  }
  return groups;
}
