# Run from the workspace directory. KONTE_VERSION selects a release tag or latest.
param([switch]$Yes)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'shiwano/konte'
  $version = $env:KONTE_VERSION
  if (-not $version -and (Test-Path -LiteralPath 'konte.version')) {
    $version = (Get-Content -Raw -LiteralPath 'konte.version').Trim()
  }
  if (-not $version) { $version = 'latest' }
  if ($version -ne 'latest') { $version = 'v' + $version.TrimStart('v') }
  $installRoot = Join-Path (Get-Location).ProviderPath '.konte'
  $binDir = (Join-Path $installRoot 'bin').TrimEnd('\')

  $osArch = $null
  try { $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
  if (-not $osArch) {
    $osArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  if (-not $osArch) { throw "cannot determine architecture" }

  switch -Regex ($osArch) {
    '^(X64|AMD64)$' { $asset = 'konte-windows-x64.exe' }
    # bun has no windows-arm64 compile target, so there is no arm64 build to serve.
    # Windows 11 on ARM runs the x64 one under emulation; Windows 10 on ARM cannot.
    '^ARM64$' {
      $asset = 'konte-windows-x64.exe'
      Write-Host "konte: no arm64 build; installing the x64 build (needs Windows 11 on ARM)"
    }
    default { throw "unsupported architecture '$osArch'" }
  }

  $base = if ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
  } else {
    "https://github.com/$repo/releases/download/$version"
  }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $dest = Join-Path $binDir 'konte.exe'
  # Staged inside the install directory, so the replace below is a rename within
  # one volume rather than a copy that can truncate a working install.
  $tmp = Join-Path $binDir ("konte-" + [System.IO.Path]::GetRandomFileName() + ".tmp")
  $sums = "$tmp.SHA256SUMS"

  $savedTls = [Net.ServicePointManager]::SecurityProtocol
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try {
    Write-Host "konte: downloading $asset ($version)"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmp
    } catch {
      throw "download failed: $base/$asset ($($_.Exception.Message))"
    }

    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    } catch {
      throw "cannot fetch SHA256SUMS to verify $asset"
    }
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].Trim().TrimStart('*') -eq $asset) {
        $expected = $parts[0].ToLower()
        break
      }
    }
    if (-not $expected) { throw "$asset not listed in SHA256SUMS" }
    if ($expected -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()) {
      throw "checksum mismatch for $asset"
    }

    # A running konte.exe (an agent's MCP server) cannot be overwritten or deleted,
    # but it can be renamed.
    Get-ChildItem -LiteralPath $binDir -Filter 'konte-*.old' |
      Remove-Item -Force -ErrorAction SilentlyContinue
    $old = $null
    if (Test-Path -LiteralPath $dest) {
      $old = Join-Path $binDir ("konte-" + [System.IO.Path]::GetRandomFileName() + ".old")
      try {
        Move-Item -LiteralPath $dest -Destination $old
      } catch {
        throw "cannot move aside $dest ($($_.Exception.Message))"
      }
    }
    try {
      Move-Item -LiteralPath $tmp -Destination $dest
    } catch {
      if ($old) { Move-Item -LiteralPath $old -Destination $dest -ErrorAction SilentlyContinue }
      throw "cannot replace $dest ($($_.Exception.Message))"
    }
    if ($old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    Remove-Item -LiteralPath $tmp, $sums -Force -ErrorAction SilentlyContinue
  }
  Write-Host "konte: installed to $dest"

  $command = if (Test-Path -LiteralPath 'konte.config.json') { 'setup' } else { 'new' }
  $commandArgs = @('workspace', $command)
  if ($Yes) { $commandArgs += '--yes' }
  & $dest @commandArgs
  if ($LASTEXITCODE -ne 0) { throw "konte workspace $command failed (exit $LASTEXITCODE)" }
  if (-not (Test-Path -LiteralPath 'konte.config.json')) { throw "workspace creation was aborted" }
  Write-Host "KONTE_BIN=$dest"
}
