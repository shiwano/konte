---
name: setup
description: Create or set up a konte workspace. Use when starting with konte, creating a workspace, or preparing a cloned or moved workspace.
---

Done = the workspace's setup script succeeds and the user receives the restart steps.

## 1. Choose the directory

- **Use the requested workspace directory.** Create it if needed, then enter it.
- Inside an existing workspace → use its root (the directory holding `konte.config.json`).
- No destination given: an empty directory or fresh Git repository → use cwd; other files → ask for the destination.

## 2. Download and run

Run from the chosen directory. Keep the downloaded script in a temporary directory outside the workspace.

macOS / Linux / WSL:

```sh
konte_setup_script=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/shiwano/konte/main/setup.sh -o "$konte_setup_script"
sh "$konte_setup_script"
```

Native Windows (PowerShell):

```powershell
$konteSetupScript = Join-Path ([IO.Path]::GetTempPath()) ('konte-setup-' + [Guid]::NewGuid() + '.ps1')
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/shiwano/konte/main/setup.ps1 -OutFile $konteSetupScript
& $konteSetupScript
```

- **Continue only after a successful download and script exit.**
- Version: `KONTE_VERSION` override → committed `konte.version` → latest. For a requested version, set `KONTE_VERSION` for the script invocation; PowerShell: restore the previous environment value afterward.
- Nonempty destination approved by the user → pass `--yes` (sh) / `-Yes` (PowerShell).
- Checksum or download failure → retry once; still failing → report and stop.
- OS security blocks the binary → report the exact error and stop; do not change security settings.

## 3. Hand off

1. Tell the user to restart the agent in the workspace directory. For a GUI app, fully quit and relaunch it to restart the app process; opening a new chat or closing the window is insufficient.
2. Accept the MCP server prompt (Claude Code) / trust the project config (Codex).
3. Run `/konte-checkin` (Claude Code) / `$konte-checkin` (Codex).

**End here.** Video creation and production belong to the workspace's skills after restart.
