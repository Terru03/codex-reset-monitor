param(
    [string]$Destination = "$env:USERPROFILE\Documents\AI\codex-reset-monitor-nicu"
)

$ErrorActionPreference = "Stop"
$sourceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$nicuRepo = "Terru03/codex-reset-monitor-nicu"
$nicuAuthHome = ".codex-reset-monitor-auth-nicu"
$nicuTokenPath = Join-Path $env:LOCALAPPDATA "CodexResetMonitor\nicu-ingest-token.dpapi"

if (Test-Path $Destination) {
    throw "Destination already exists: $Destination"
}

Write-Host "Creating Nicu monitor in $Destination"
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

Get-ChildItem -LiteralPath $sourceRoot -Force |
    Where-Object { $_.Name -notin @(".git", "discord-worker") } |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }

$workflowPath = Join-Path $Destination ".github\workflows\monitor.yml"
$workflow = Get-Content -LiteralPath $workflowPath -Raw
$workflow = $workflow.Replace("ACCOUNT_LABEL: David", "ACCOUNT_LABEL: Nicu")
$workflow = $workflow.Replace("ACCOUNT_SLUG: david", "ACCOUNT_SLUG: nicu")
$workflow = $workflow.Replace("group: codex-reset-monitor", "group: codex-reset-monitor-nicu")
Set-Content -LiteralPath $workflowPath -Value $workflow -Encoding UTF8

$statePath = Join-Path $Destination "state\reset-state.json"
@'
{
  "version": 1,
  "windows": {}
}
'@ | Set-Content -LiteralPath $statePath -Encoding UTF8

Remove-Item -LiteralPath (Join-Path $Destination "secrets\auth.json.enc") -Force -ErrorAction SilentlyContinue

$distros = (wsl.exe -l -q) -replace [char]0,"" | Where-Object { $_ -and $_ -notmatch "docker-desktop" }
$codexDistro = $null
foreach ($d in $distros) {
    $check = wsl.exe -d $d -- sh -lc 'command -v bash >/dev/null 2>&1 && command -v codex >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 && echo OK'
    if ($check -match "OK") {
        $codexDistro = $d.Trim()
        break
    }
}
if (-not $codexDistro) {
    throw "Could not find a WSL distro containing bash, codex, and openssl."
}

Write-Host ""
Write-Host "Starting isolated Codex login for Nicu."
Write-Host "Complete the device login with NICU'S OpenAI account."
$loginCmd = 'mkdir -p "$HOME/' + $nicuAuthHome + '" && CODEX_HOME="$HOME/' + $nicuAuthHome + '" codex login --device-auth'
wsl.exe -d $codexDistro -- bash -lc $loginCmd
if ($LASTEXITCODE -ne 0) {
    throw "Nicu Codex login failed."
}

$probeRoot = $Destination.Replace('','/')
$drive = $probeRoot.Substring(0,1).ToLower()
$rest = $probeRoot.Substring(2)
$destWsl = "/mnt/$drive$rest"
$probeCmd = 'cd "' + $destWsl + '" && CODEX_HOME="$HOME/' + $nicuAuthHome + '" python3 ./scripts/local_probe.py'
Write-Host ""
Write-Host "Verifying Nicu Codex usage..."
wsl.exe -d $codexDistro -- bash -lc $probeCmd
if ($LASTEXITCODE -ne 0) {
    throw "Nicu usage probe failed."
}

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $authFileKey = [Convert]::ToBase64String($bytes)
}
finally {
    $rng.Dispose()
}

$encryptCmd = 'export AUTH_FILE_KEY=''' + $authFileKey + '''; openssl enc -aes-256-cbc -pbkdf2 -salt -in "$HOME/' + $nicuAuthHome + '/auth.json" -out "' + $destWsl + '/secrets/auth.json.enc" -pass env:AUTH_FILE_KEY'
wsl.exe -d $codexDistro -- bash -lc $encryptCmd
if ($LASTEXITCODE -ne 0) {
    throw "Failed to encrypt Nicu auth."
}

if (-not (Test-Path $nicuTokenPath)) {
    throw "Nicu ingest token not found. Expected: $nicuTokenPath"
}
$secureNicuToken = Get-Content -LiteralPath $nicuTokenPath -Raw | ConvertTo-SecureString
$nicuIngestToken = [System.Net.NetworkCredential]::new("", $secureNicuToken).Password

$secureDiscordWebhook = Read-Host "Paste the SAME Discord webhook URL used by David (hidden)" -AsSecureString
$discordWebhook = [System.Net.NetworkCredential]::new("", $secureDiscordWebhook).Password
$discordUserId = Read-Host "Paste your numeric Discord User ID"
if ($discordUserId -notmatch '^\d{17,20}$') {
    throw "Discord User ID is not valid."
}

Set-Location $Destination
git init -b main
git add .
git commit -m "Initial Nicu Codex reset monitor"

gh repo create codex-reset-monitor-nicu --public --source . --remote origin --push

gh secret set AUTH_FILE_KEY -R $nicuRepo --body $authFileKey
gh secret set DISCORD_WEBHOOK_URL -R $nicuRepo --body $discordWebhook
gh secret set DISCORD_USER_ID -R $nicuRepo --body $discordUserId
gh secret set STATUS_INGEST_TOKEN -R $nicuRepo --body $nicuIngestToken

Write-Host ""
Write-Host "Triggering Nicu's first GitHub check..."
gh workflow run monitor.yml -R $nicuRepo
Start-Sleep -Seconds 5
$runId = gh run list -R $nicuRepo --workflow monitor.yml --limit 1 --json databaseId --jq '.[0].databaseId'
if ($runId) {
    gh run watch $runId -R $nicuRepo --exit-status
}

Write-Host ""
Write-Host "Nicu monitor deployed."
Write-Host "Repository: https://github.com/$nicuRepo"
Write-Host "Isolated Codex home: ~/$nicuAuthHome"
