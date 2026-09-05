# Financial Brain preflight (Windows). Reads the machine, changes nothing.
$script:Warned = 0; $script:Stopped = 0; $script:Fresh = $false; $script:NoManifest = $false
function Ok  ($m){ Write-Host "  ok    $m" }
function Warn($m){ Write-Host "  WARN  $m"; $script:Warned++ }
function Stop_($m){ Write-Host "  STOP  $m"; $script:Stopped++ }

Write-Host "Financial Brain preflight  -  $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Write-Host ""

Write-Host "MACHINE"
Write-Host ("  os              " + [System.Environment]::OSVersion.VersionString)
Write-Host ("  powershell      " + $PSVersionTable.PSVersion)
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nv = (& node -v); Write-Host "  node            $nv ($($node.Source))"
  $maj = [int](($nv -replace '^v','') -split '\.')[0]
  if ($maj -lt 22) { Stop_ "node $nv is too old; the installer needs 22 or newer" }
} else { Stop_ "node is not installed" }
if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { Write-Host ("  npm             " + (& npm.cmd -v)) }
else { Stop_ "npm.cmd not found" }
Write-Host ""

Write-Host "WINDOWS TRAPS"
# Read the scopes a fresh normal PowerShell window inherits, not this process's
# effective policy: a launch with -ExecutionPolicy Bypass (or a CI runner) would
# otherwise hide the very setting that blocks the client's own shell.
$scopes = Get-ExecutionPolicy -List
$user = ($scopes | Where-Object Scope -eq 'CurrentUser').ExecutionPolicy
$machine = ($scopes | Where-Object Scope -eq 'LocalMachine').ExecutionPolicy
$pol = if ($user -ne 'Undefined') { $user } elseif ($machine -ne 'Undefined') { $machine } else { 'Undefined' }
Write-Host "  execution policy $pol  (CurrentUser=$user, LocalMachine=$machine)"
if ($pol -in @('Restricted','AllSigned','Undefined')) {
  Warn "the bare 'brain', 'npm' and 'npx' resolve to blocked .ps1 shims under this policy. Use brain.cmd, npm.cmd and npx.cmd."
} else { Ok "policy allows the .ps1 shims (the .cmd forms are still safe to use)" }
if ($env:APPDATA -like '*\Packages\*') {
  Stop_ "this shell is inside an MSIX sandbox (APPDATA = $env:APPDATA). A global install here lands where no ordinary shell can see it. Open a normal PowerShell window."
} else { Ok "not running inside an MSIX/Claude sandboxed shell" }
Write-Host ""

Write-Host "THE BRAIN CLI"
$copies = @()
foreach ($n in @('brain','brain.cmd')) {
  $c = Get-Command $n -All -ErrorAction SilentlyContinue
  if ($c) { $copies += ($c | ForEach-Object { $_.Source }) }
}
$copies = $copies | Where-Object { $_ } | Sort-Object -Unique
if ($copies.Count -eq 0) { $script:Fresh = $true; Warn "no 'brain' on PATH (fine before a first install; call it by full path otherwise)" }
elseif ($copies.Count -eq 1) { Ok "resolves to $($copies[0])" }
else {
  Stop_ "$($copies.Count) copies of the CLI are visible; the first wins and it may not be the one you updated"
  $copies | ForEach-Object { Write-Host "          $_" }
}
$fb = "$env:LOCALAPPDATA\FinancialBrain"
if (Test-Path "$fb\brain.cmd") { Ok "install target exists: $fb" } else { Warn "no $fb yet; install with --prefix to that path so there is one home" }
Write-Host ""

Write-Host "CLOUDFLARE ACCESS"
if ($env:CLOUDFLARE_API_TOKEN) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 -Uri "https://api.cloudflare.com/client/v4/accounts" -Headers @{Authorization="Bearer $env:CLOUDFLARE_API_TOKEN"}
    if ($r.StatusCode -eq 200) { Ok "CLOUDFLARE_API_TOKEN is set and works" } else { Stop_ "CLOUDFLARE_API_TOKEN set but rejected ($($r.StatusCode)). Unset it." }
  } catch { Stop_ "CLOUDFLARE_API_TOKEN is set but REJECTED. It beats the browser sign-in and disables renewal. Remove-Item Env:\CLOUDFLARE_API_TOKEN" }
} else { Ok "no CLOUDFLARE_API_TOKEN in the environment (browser sign-in will be used)" }
$cfgCandidates = @()
if ($env:APPDATA) {
  $cfgCandidates += Join-Path $env:APPDATA "xdg.config\.wrangler\config"
  $cfgCandidates += Join-Path $env:APPDATA ".wrangler\config"
}
if ($env:LOCALAPPDATA) { $cfgCandidates += Join-Path $env:LOCALAPPDATA ".wrangler\config" }
if ($env:XDG_CONFIG_HOME) { $cfgCandidates += Join-Path $env:XDG_CONFIG_HOME ".wrangler\config" }
$homeDir = if ($env:HOME) { $env:HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
if ($homeDir) {
  $cfgCandidates += Join-Path $homeDir ".config\.wrangler\config"
  $cfgCandidates += Join-Path $homeDir ".wrangler\config"
}
$session = $null
foreach ($cfg in $cfgCandidates) {
  $toml = Join-Path $cfg "default.toml"
  $enc = Join-Path $cfg "default.enc"
  if (Test-Path $toml) { $session = @{ Path = $toml; Format = "toml" }; break }
  if (Test-Path $enc) { $session = @{ Path = $enc; Format = "encrypted" }; break }
}
if ($session -and $session.Format -eq "toml") { Ok "wrangler session found (default.toml, the format the installer reads)" }
elseif ($session -and $session.Format -eq "encrypted") { Stop_ "wrangler wrote default.enc, which the installer cannot read. Sign in with: npx.cmd wrangler@4.73.0 login" }
else { Warn "no wrangler session yet. Sign in with: npx.cmd wrangler@4.73.0 login" }
Write-Host ""

Write-Host "NETWORK"
foreach ($p in @(@('api.github.com','https://api.github.com'), @('github.com','https://github.com'), @('release assets','https://release-assets.githubusercontent.com'))) {
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 -Uri $p[1] -MaximumRedirection 0 -ErrorAction Stop; Ok "$($p[0]) reachable (http $($r.StatusCode))" }
  catch { if ($_.Exception.Response) { Ok "$($p[0]) reachable (http $([int]$_.Exception.Response.StatusCode))" } else { Stop_ "$($p[0]) unreachable; the download will fail" } }
}
Write-Host ""

Write-Host "RELEASE"
try {
  $rel = Invoke-RestMethod -TimeoutSec 15 "https://api.github.com/repos/guldanjaMAX/brain-installer/releases/latest"
  Ok "current release is $($rel.tag_name)"
} catch { Warn "could not read the current release" }
Write-Host ""

Write-Host "MANIFESTS"
$mf = @(Get-ChildItem -Path $HOME -Recurse -Depth 4 -Filter brain.manifest.json -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch 'node_modules|templates' })
if ($mf.Count -eq 0) { $script:NoManifest = $true; Ok "no manifest yet (expected before a first install)" }
elseif ($mf.Count -eq 1) {
  Ok "one manifest: $($mf[0].FullName)"
  try {
    $m = Get-Content $mf[0].FullName -Raw | ConvertFrom-Json
    $dom = $m.brain.domain
    if ($dom) {
      $h = Invoke-RestMethod -TimeoutSec 15 "https://$dom/health"
      if ($h.status -eq 'ok') { Ok "brain at $dom is ok, accepting_documents=$($h.accepting_documents)" }
      elseif ($h.status -eq 'paused-for-upgrade') { Stop_ "brain at $dom is PAUSED (an update did not finish). See /kit/known-issues" }
      else { Warn "brain at $dom reports status=$($h.status)" }
    }
  } catch { Warn "could not read the manifest or reach its brain" }
} else {
  Stop_ "$($mf.Count) manifests found; the wrong one will be picked. Ask which folder is theirs."
  $mf | ForEach-Object { Write-Host "          $($_.FullName)" }
}
Write-Host ""
Write-Host "-----"
if ($script:Stopped -gt 0) { Write-Host "$($script:Stopped) thing(s) will stop the install, and $($script:Warned) worth knowing."; Write-Host "Clear the STOP lines first. Each one says what to do."; exit 1 }
elseif ($script:Warned -gt 0) {
  if ($script:Fresh -and $script:NoManifest) {
    Write-Host "Nothing is wrong here. This is a machine before its first install,"
    Write-Host "and every line above says so. Go ahead and start."
  } else {
    Write-Host "$($script:Warned) thing(s) to be aware of, none of them blocking. Read them, then carry on."
  }
  exit 0
}
else { Write-Host "All clear."; exit 0 }
