// The exit status a konte process returns when it wants to be started again in its place: the CLI
// entry (src/cli/index.ts) runs every command in a child it re-execs, and on this status it spawns
// a fresh child on the same stdio instead of exiting. A long-lived process asks for it when it has
// proven its own loaded definitions are older than the files on disk (see definition-source.ts) —
// nothing it can do in-process is trusted past that point, and a new process reads fresh.
export const RESTART_EXIT_CODE = 75;
