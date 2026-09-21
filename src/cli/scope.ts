import type { Command } from "commander";

/**
 * What a command needs before it runs.
 *
 * - `none` — no konte roots at all (`workspace new` has no workspace yet; `lsp` is launched by
 *   an editor from anywhere).
 * - `workspace` — a workspace, but no particular video.
 * - `video` — a workspace and one selected video. The default, and what all ~30 asset-level
 *   commands want; a command opts out explicitly rather than by omission.
 */
export type Scope = "none" | "workspace" | "video";

interface CommandScope {
  scope: Scope;
  /** Skip the managed-template re-sync (the MCP server must not write on startup). */
  skipSync?: boolean;
  /** Skip the workspace type-check (`doctor` reports type errors; `adapter comfy` predates them). */
  skipTypeCheck?: boolean;
}

const DEFAULT: CommandScope = { scope: "video" };

const scopes = new WeakMap<Command, CommandScope>();

export function declareScope(command: Command, scope: CommandScope): Command {
  scopes.set(command, scope);
  return command;
}

export function scopeOf(command: Command): CommandScope {
  return scopes.get(command) ?? DEFAULT;
}
