#Requires -Version 7.4
# Run from a reviewed checkout; never pipe a mutable download into this script.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
    [switch]$Provision,
    [switch]$TrustLocalSource,
    [switch]$Apply,
    [string]$BunVersion,
    [string]$BunSha256,
    [string]$Source,
    [ValidateSet('stable','latest')][string]$Channel,
    [switch]$Claude,
    [switch]$Codex
)
$ErrorActionPreference = 'Stop'
# Keep verification and the installer bound to this checkout, even inside hooks.
foreach ($name in @('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
function Invoke-Provision([string]$Program, [string[]]$Arguments) {
    $seconds = 300.0
    if ($env:JIG_SETUP_TIMEOUT_SECONDS) {
        if (-not [double]::TryParse($env:JIG_SETUP_TIMEOUT_SECONDS, [ref]$seconds) -or
            -not [double]::IsFinite($seconds) -or $seconds -le 0 -or $seconds * 1000 -gt [int]::MaxValue) {
            throw 'JIG_SETUP_TIMEOUT_SECONDS must be positive seconds within the process wait limit'
        }
    }
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command $Program -CommandType Application -ErrorAction Stop).Source)
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    try {
        if (-not $process.Start()) { throw "Cannot start $Program" }
        $started = $true
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit([int][Math]::Ceiling($seconds * 1000))) {
            throw "Provisioning timed out after $($seconds)s (JIG_SETUP_TIMEOUT_SECONDS): $Program"
        }
        $text = $stdout.WaitAsync([TimeSpan]::FromMilliseconds([Math]::Max(1, $seconds * 1000 - $clock.ElapsedMilliseconds))).GetAwaiter().GetResult()
        $errorText = $stderr.WaitAsync([TimeSpan]::FromMilliseconds([Math]::Max(1, $seconds * 1000 - $clock.ElapsedMilliseconds))).GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "$Program failed (exit $($process.ExitCode)): $errorText $text" }
        if ($errorText) { [Console]::Error.WriteLine($errorText) }
        return $text
    } finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            if (-not $process.WaitForExit(5000)) { throw "Cannot confirm $Program stopped after termination" }
        }
        $process.Dispose()
    }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$platform = [Runtime.InteropServices.RuntimeInformation]::OSDescription
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
Write-Output "Platform: $platform/$architecture; shell: PowerShell $($PSVersionTable.PSVersion)"
if ($env:OS -ne 'Windows_NT') { throw 'Use bootstrap.sh on macOS or Linux' }
if ($architecture -notin @('x64','arm64')) { throw "Unsupported architecture: $architecture" }
$missing = @('bun','git','gh') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
Write-Output "Missing tools: $($missing -join ', ')"
Write-Output 'Plan: provision only missing prerequisites with -Provision; plugin writes require -Apply. No automatic login or scheduled jobs.'
if ($Claude -and $Codex) { throw 'Choose at most one agent, or neither for both' }
if ($Source -and $Channel -and $Source.Contains('#')) { throw 'Source ref and channel contradict each other' }
$agents = if ($Claude) { @('claude') } elseif ($Codex) { @('codex') } else { @('claude','codex') }
$availableAgents = @($agents | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue })
foreach ($agent in $agents) { Write-Output "$agent`: $(if ($agent -in $availableAgents) {'available'} else {'missing'})" }
if ($availableAgents.Count -eq 0) { throw 'Install a supported agent CLI explicitly, then rerun bootstrap' }
function Assert-Source {
    $head = & git -C $root rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -ne $Revision) { throw 'Checkout does not match reviewed revision' }
    $dirty = & git -C $root status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Tracked source has local changes; review a clean checkout first' }
    & git -C $root ls-files --error-unmatch -- tools/plugin/bootstrap.ps1 tools/plugin/bootstrap.ts | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bootstrap files are not part of the reviewed commit' }
}
if (Get-Command git -ErrorAction SilentlyContinue) { Assert-Source }
elseif (-not $TrustLocalSource) { throw 'Git is missing: review the local source yourself and pass -TrustLocalSource to provision prerequisites, or install git first' }
if ($missing.Count -gt 0) {
    if (-not $Provision) { Write-Output 'Preview only. Install missing tools or rerun with -Provision. Bun needs -BunVersion and -BunSha256 from its reviewed GitHub release asset.'; exit 1 }
    if ('bun' -in $missing -and ($BunVersion -notmatch '^\d+\.\d+\.\d+$' -or $BunSha256 -notmatch '^[0-9a-f]{64}$')) { throw 'Bun provisioning requires an immutable version and reviewed SHA-256 digest' }
    $packages = @{ git = 'Git.Git'; gh = 'GitHub.cli' }
    foreach ($tool in $missing) {
        if ($tool -eq 'bun') { continue }
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install git and gh explicitly, or provide an existing trusted WinGet installation' }
        # The name alone is not a trust boundary: check the configured source URL.
        $sourcesText = Invoke-Provision winget @('source','export','--name','winget')
        $sources = ($sourcesText -join "`n") | ConvertFrom-Json
        $entries = @($sources)
        if ($entries.Count -ne 1 -or $entries[0].Arg -ne 'https://cdn.winget.microsoft.com/cache' -or $entries[0].Name -ne 'winget' -or $entries[0].Type -ne 'Microsoft.PreIndexed.Package') { throw 'The winget source is not the expected Microsoft source' }
        Write-Output "Provision: $($packages[$tool]) through the existing Microsoft WinGet source; installer hashes remain enforced."
        Invoke-Provision winget @('install','--id',$packages[$tool],'--exact','--source','winget','--disable-interactivity')
    }
    if ('bun' -in $missing) {
        $target = Join-Path $env:USERPROFILE '.bun/bin/bun.exe'
        if (Test-Path $target) { throw "Bun exists outside PATH at $target; inspect it instead of overwriting" }
        $assetArch = if ($architecture -eq 'arm64') { 'aarch64' } else { 'x64' }
        $asset = "bun-windows-$assetArch"
        $url = [uri]"https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/$asset.zip"
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
        [IO.Directory]::CreateDirectory($scratch) | Out-Null
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $client = [Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(120)
        try {
            Write-Output "Provision: Bun $BunVersion, SHA-256 $BunSha256; write $target. No shell profile edits."
            $archive = Join-Path $scratch 'bun.zip'
            $complete = $false
            for ($hop = 0; $hop -lt 4; $hop++) {
                if ($url.Scheme -ne 'https' -or $url.UserInfo -or $url.Port -ne 443 -or $url.Host -notin @('github.com','release-assets.githubusercontent.com')) { throw 'Unexpected download destination' }
                if ($url.Host -eq 'github.com' -and -not $url.AbsolutePath.StartsWith('/oven-sh/bun/releases/download/')) { throw 'Unexpected GitHub download path' }
                $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
                try {
                    if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                        $url = [uri]::new($url, $response.Headers.Location)
                        continue
                    }
                    if ([int]$response.StatusCode -ne 200) { throw "Download failed: HTTP $([int]$response.StatusCode)" }
                    if ($response.Content.Headers.ContentLength -gt 104857600) { throw 'Download is too large' }
                    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                    $file = [IO.File]::Create($archive)
                    try {
                        $buffer = [byte[]]::new(65536)
                        $total = 0
                        $deadline = [DateTime]::UtcNow.AddSeconds(120)
                        while (($read = $stream.ReadAsync($buffer,0,$buffer.Length).WaitAsync([TimeSpan]::FromSeconds(15)).GetAwaiter().GetResult()) -gt 0) {
                            $total += $read
                            if ($total -gt 104857600 -or [DateTime]::UtcNow -gt $deadline) { throw 'Download exceeded size/time limit' }
                            $file.Write($buffer,0,$read)
                        }
                    } finally { $file.Dispose(); $stream.Dispose() }
                    $complete = $true
                    break
                } finally { $response.Dispose() }
            }
            if (-not $complete) { throw 'Too many download redirects' }
            if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $BunSha256) { throw 'Bun checksum mismatch; no downloaded code executed' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $entry = $zip.GetEntry("$asset/bun.exe")
                if (-not $entry -or $entry.Length -eq 0 -or $entry.Length -gt 314572800) { throw 'Invalid Bun archive' }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $scratch 'bun.exe'))
            } finally { $zip.Dispose() }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            Move-Item -LiteralPath (Join-Path $scratch 'bun.exe') -Destination $target
            $env:PATH = "$(Split-Path $target);$env:PATH"
        } finally { $client.Dispose(); $handler.Dispose(); Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    # Package installers may update the persistent PATH for new processes.
    $env:PATH = "$env:PATH;$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
}
Assert-Source
$setupArgs = @()
if ($Apply) { $setupArgs += '--apply' }
if ($Source) { $setupArgs += @('--source',$Source) }
if ($Channel) { $setupArgs += @('--channel',$Channel) }
if ($Claude -and $Codex) { throw 'Choose at most one agent, or neither for both' }
if ($Claude) { $setupArgs += '--claude' }
if ($Codex) { $setupArgs += '--codex' }
& bun --no-env-file --config (Join-Path $root 'plugin/gc/bunfig.toml') (Join-Path $PSScriptRoot 'bootstrap.ts') @setupArgs
exit $LASTEXITCODE
