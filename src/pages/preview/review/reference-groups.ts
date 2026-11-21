import type {
  ReferenceAssetInfo,
  ReferenceGroupInfo,
  ReferenceGroupKind,
  ReferenceGroupMemberInfo,
} from "../../../core/types/review-state.js";

export interface ReferenceRowInfo {
  // Unique on the page: a sample cast twice is a row in each of its groups.
  key: string;
  group: ReferenceGroupInfo;
  member: ReferenceGroupMemberInfo;
  asset: ReferenceAssetInfo;
}

interface ReferenceSubject {
  group: ReferenceGroupInfo;
  rows: ReferenceRowInfo[];
}

export interface ReferenceSection {
  title: string;
  subjects: ReferenceSubject[];
}

const SECTIONS: Array<{ title: string; kinds: ReferenceGroupKind[] }> = [
  { title: "Cast", kinds: ["character", "narrator"] },
  { title: "Props", kinds: ["prop"] },
  { title: "Places", kinds: ["location"] },
  { title: "Sound", kinds: ["song"] },
  { title: "Materials", kinds: ["material"] },
];

export const GROUP_KIND_LABEL: Record<ReferenceGroupKind, string> = {
  character: "Character",
  narrator: "Narrator",
  prop: "Prop",
  location: "Place",
  song: "Song",
  material: "Material",
};

// The page's sections in review order, each subject with a row per asset it holds on the page.
export function referenceSections(
  groups: readonly ReferenceGroupInfo[],
  assets: readonly ReferenceAssetInfo[],
): ReferenceSection[] {
  const byAddress = new Map(assets.map((a) => [a.address, a]));
  return SECTIONS.flatMap(({ title, kinds }) => {
    const subjects = groups
      .filter((g) => kinds.includes(g.kind))
      .map((group) => ({
        group,
        rows: group.members.flatMap((member) => {
          const asset = byAddress.get(member.address);
          return asset ? [{ key: `${group.id}|${member.address}`, group, member, asset }] : [];
        }),
      }))
      .filter((s) => s.rows.length > 0);
    return subjects.length > 0 ? [{ title, subjects }] : [];
  });
}

// What a row is inside its subject, or null where the subject's name already says it.
export function referenceMemberLabel(member: ReferenceGroupMemberInfo): string | null {
  switch (member.role) {
    case "look":
      return "Look";
    case "voice":
      return "Voice";
    case "master":
      return "Master";
    case "view":
      return `${(member.view ?? "").replace(/^./, (c) => c.toUpperCase())} view`;
    default:
      return null;
  }
}

// An asset by its subject, as the submit dialog names it.
export function referenceRowLabel(row: ReferenceRowInfo): string {
  const label = referenceMemberLabel(row.member);
  if (row.group.kind === "material" || label === null) return row.asset.assetName;
  return row.group.members.length > 1 ? `${row.group.name}: ${label}` : row.group.name;
}
