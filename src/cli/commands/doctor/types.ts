import type {
  AnimaticDefinition,
  ReferenceDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";

export type CheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
  details?: string[];
  // A backend connectivity/health check. Its passing form carries live diagnostics (GPU/VRAM,
  // queue depth) worth surfacing, so it is shown even when PASS if --backends asked to survey.
  backend?: boolean;
  // The video a --all-videos check is about; absent for a workspace-level check.
  video?: string;
};

// A video doctor checks; `name` is null for the current video alone, whose checks print ungrouped.
export type DoctorVideo = { name: string | null; root: string };

export type DefinitionSet = {
  video: VideoDefinition | null;
  animatic: AnimaticDefinition | null;
  reference: ReferenceDefinition | null;
};

export type VideoDefinitionSet = DefinitionSet & { name: string | null };
