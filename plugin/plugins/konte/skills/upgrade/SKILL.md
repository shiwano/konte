---
name: upgrade
description: Update or reinstall one workspace's konte binary. Use when the user requests an upgrade, a specific release, or repair of a broken installation.
---

Done = the selected workspace's setup succeeds, its binary reports the requested version, and the user receives the restart steps.

1. **Locate the workspace root**: cwd's enclosing workspace; outside one → ask which. Note its `.konte/bin/konte --version` (`konte.exe` on Windows), resolving the absolute path before invocation. If it cannot start, read `konte.version` for the previous version.
2. **Run the setup skill** in that workspace with `KONTE_VERSION=latest`, or the requested release tag. Repair without a version change uses the recorded `konte.version`.
3. Verify the path on setup's final `KONTE_BIN=<absolute path>` line with `--version` (PowerShell: `& "<path>"`); report the old and new versions and the workspace updated.
