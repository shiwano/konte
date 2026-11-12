---
name: konte-upgrade
description: Update or reinstall this workspace's konte binary. Use when the user requests an upgrade, a specific release, or repair of a broken installation.
user-invocable: true
---

Done = setup.sh succeeds in this workspace, its binary reports the requested version, and the user is told to start a new session.

## 1. Record the old version

- Workspace root = the directory holding `konte.config.json`; run every step from there.
- Run `.konte/bin/konte --version` (`konte.exe` on Windows) by its absolute path. It cannot start → read `konte.version`.

## 2. Pick the version

- Upgrade → `KONTE_VERSION=latest`, or the requested release tag.
- Repair without a version change → no `KONTE_VERSION`; the script reads `konte.version`.
- A release older than `konte.version` → write it, without the `v`, into `konte.version` and set no `KONTE_VERSION`.

## 3. Download and run

`<version>` is step 2's; no `KONTE_VERSION` → drop the assignment.

macOS / Linux / WSL:

```sh
konte_setup_script=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/shiwano/konte/main/setup.sh -o "$konte_setup_script"
KONTE_VERSION=<version> sh "$konte_setup_script"
```

Native Windows (PowerShell):

```powershell
$konteSetupScript = Join-Path ([IO.Path]::GetTempPath()) ('konte-setup-' + [Guid]::NewGuid() + '.ps1')
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/shiwano/konte/main/setup.ps1 -OutFile $konteSetupScript
$env:KONTE_VERSION = '<version>'; & $konteSetupScript
```

- Codex → run the script outside the sandbox, with approval.
- PowerShell: restore the previous `KONTE_VERSION` value afterward.
- Checksum or download failure → retry once; still failing → report and stop.
- OS security blocks the binary → report the exact error and stop; do not change security settings.

## 4. Verify

1. Run the path on the script's final `KONTE_BIN=<absolute path>` line with `--version` (PowerShell: `& "<path>"`).
2. Report the old and new versions.
3. Tell the user to start a new session in the workspace directory.
