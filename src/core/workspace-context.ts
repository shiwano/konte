// The one place ambient process state is correct. The managed runtimes (ffmpeg, tsc, chromium,
// hyperframes) are argument-less module singletons reached from ~25 deep call sites; threading a
// root through all of them would buy nothing, since a konte process only ever serves one workspace.
// Set once in the CLI preAction, before anything can provision a runtime.

let workspaceRoot: string | null = null;

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root;
}

export function workspaceRootOrNull(): string | null {
  return workspaceRoot;
}
