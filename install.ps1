# deckrun - one-command installer for Windows (PowerShell)
#
#   irm https://raw.githubusercontent.com/arpitbbhayani/deckrun/master/install.ps1 | iex
#
# Installs deckrun globally from npm. If Node.js (>= 16) is missing or too
# old, it installs the Node.js LTS (via winget when available, otherwise by
# downloading the Node.js .msi), refreshes PATH, then installs deckrun.

$ErrorActionPreference = 'Stop'

$NodeMin = 16

function Write-Info  { Write-Host "deckrun $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "✓ $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "! $args" -ForegroundColor Yellow }

function Get-NodeMajor([string]$Version) {
    if ($Version -match '^v?(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Get-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try { return (node --version) } catch { return $null }
}

function Add-PathToSession([string]$Dir) {
    $env:Path = "$Dir;$env:Path"
}

# Persist to the per-user PATH so it survives new terminals without elevation.
function Add-PersistentPath([string]$Dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and $userPath.Split(';') -contains $Dir) { return }
    $new = if ($userPath) { "$userPath;$Dir" } else { $Dir }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    $env:Path = "$Dir;$env:Path"
}

# ── Ensure Node.js is installed ──────────────────────────────────────────
$ver = Get-NodeVersion
if ($ver) {
    $major = Get-NodeMajor $ver
    if ($major -ge $NodeMin) {
        Write-Info "Node.js $ver detected."
    } else {
        Write-Warn "Found Node.js $ver; deckrun needs >= $NodeMin."
        $ver = $null
    }
}

if (-not $ver) {
    Write-Info 'Installing Node.js LTS automatically…'

    $installed = $false

    # 1) winget (cleanest, per-user capable)
    #
    # Resolved to its absolute path before being run. A bare command name is
    # resolved through the search order, which on Windows includes the calling
    # process's current directory ahead of the PATH directories.
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        try {
            & $wingetCmd.Source install --id OpenJS.NodeJS.LTS --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host
            $installed = $true
        } catch {
            Write-Warn "winget install failed ($($_.Exception.Message)); falling back to direct download."
        }
    }

    # 2) Direct .msi download fallback
    if (-not $installed) {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM') { 'arm64' } else { 'x64' }
        $index = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/index.json').Content | ConvertFrom-Json
        # Pick the latest 22.x (LTS) entry that has an arch-named installer.
        $match = $index | Where-Object { $_.version -match '^v22\.' -and $_.files -contains "win-$arch/msi" } | Select-Object -First 1
        if (-not $match) {
            $match = $index | Select-Object -First 1
        }
        $version = $match.version
        $msiName = "node-$version-$arch.msi"

        # Staged in a freshly created directory with an unpredictable name.
        # %TEMP% is writable by every process running as this user, so a
        # predictable path there can be overwritten between the download
        # finishing and elevated msiexec opening the file — the victim then
        # approves the UAC prompt they were expecting and the replacement MSI's
        # custom actions run as administrator.
        $stageRoot = Join-Path $env:TEMP ("deckrun-" + [System.Guid]::NewGuid().ToString('N'))
        $stage = New-Item -ItemType Directory -Path $stageRoot -Force
        $msi = Join-Path $stage.FullName $msiName

        Write-Info "Downloading Node.js $version ($arch)…"
        Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/node-$version-$arch.msi" -OutFile $msi

        # Verified against the checksums Node publishes for the release. HTTPS
        # covers the network hop and says nothing about a compromised or
        # cached artifact.
        Write-Info 'Verifying the download…'
        $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/SHASUMS256.txt").Content
        $expected = $null
        foreach ($line in $sums -split "`n") {
            $parts = ($line.Trim() -split '\s+')
            if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq "win-$arch/$msiName") { $expected = $parts[0] }
            if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $msiName) { $expected = $parts[0] }
        }
        if (-not $expected) {
            Remove-Item $stage.FullName -Recurse -Force -ErrorAction SilentlyContinue
            throw "No published checksum for $msiName; refusing to run it."
        }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $msi).Hash
        if ($actual -ne $expected.ToUpperInvariant()) {
            Remove-Item $stage.FullName -Recurse -Force -ErrorAction SilentlyContinue
            throw "Checksum mismatch for $msiName (expected $expected, got $actual)."
        }
        Write-Ok "Verified $msiName against SHASUMS256.txt."

        # msiexec installs machine-wide and typically needs elevation, so it is
        # launched by absolute path: an unqualified name would be resolved
        # through the search order and whatever won that search would be the
        # thing the UAC prompt elevates.
        $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        if (-not (Test-Path -LiteralPath $msiexec)) {
            throw "Could not find msiexec.exe at $msiexec."
        }
        try {
            Start-Process $msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -Verb RunAs
        } catch {
            Start-Process $msiexec -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
        }
        Remove-Item $stage.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Refresh PATH to pick up the freshly installed node/npm.
    $newVer = Get-NodeVersion
    if (-not $newVer) {
        Add-PersistentPath (Join-Path $env:ProgramFiles 'nodejs')
        Add-PersistentPath (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
        $newVer = Get-NodeVersion
    }
    if (-not $newVer) {
        Write-Warn 'Node.js was installed but `node` is not visible yet.'
        Write-Warn 'Open a new PowerShell window and re-run this installer.'
        exit 1
    }
    Write-Ok "Node.js $newVer installed."
}

# ── Install deckrun ──────────────────────────────────────────────────────
Write-Info 'Installing deckrun globally via npm…'
npm install -g deckrun

# ── Verify ───────────────────────────────────────────────────────────────
if (Get-Command deckrun -ErrorAction SilentlyContinue) {
    $dv = deckrun --version 2>$null
    Write-Ok "deckrun $dv installed."
    Write-Host ''
    Write-Host "  deckrun           # open the editor" -ForegroundColor Cyan
    Write-Host "  deckrun slides.md # present a local file" -ForegroundColor Cyan
    Write-Host "  deckrun <url>     # present a public Markdown or HTML URL" -ForegroundColor Cyan
    Write-Host ''
} else {
    Write-Warn 'deckrun was installed but is not on your PATH.'
    Write-Warn 'Open a new terminal (or refresh your PATH) and run deckrun.'
}