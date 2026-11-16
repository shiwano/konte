---
name: konte-dev-upgrade
description: Switch this workspace's konte binary to the konte on PATH and migrate its videos to it. Use when the user wants the workspace on their local konte build instead of a release.
user-invocable: true
disable-model-invocation: true
---

Done = `.konte/bin/konte` links the PATH konte, `konte workspace setup` succeeds with it, every FAIL the switch introduced is fixed or reported, and the user is told to start a new session.

macOS / Linux / WSL only — konte never links its binary into a Windows workspace.

## 1. Record the old state

Run the konte-upgrade skill's step 1.

## 2. Find the PATH konte

- `which -a konte` → the first entry outside `<workspace root>/.konte/bin` is the PATH konte; run it with `--version`. None → report and stop.
- Not a compiled binary (a `bun run konte` wrapper) → report and stop — only a compiled konte links itself.

## 3. Link and sync

1. `.konte/bin/konte` is a real file → delete it — the sync never links over a real file.
2. The PATH konte's version is older than `konte.version` → write it, without the `v`, into `konte.version` — `workspace setup` refuses with `KONTE_OUTDATED` otherwise.
3. Run `<PATH konte> workspace setup` by its absolute path.
4. Run `.konte/bin/konte --version`; it must match step 2's.

## 4. Migrate and hand off

Run the konte-upgrade skill's steps 4 and 5.
