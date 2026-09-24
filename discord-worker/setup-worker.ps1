param(
    [string]$DiscordPublicKey
)

$ErrorActionPreference = "Stop"
$repo = "Terru03/codex-reset-monitor"
$workerUrl = "https://codex-reset-monitor.david-galdea.workers.dev"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptRoot

function New-StrongToken {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+","-").Replace("/","_")
    }
    finally {
        $rng.Dispose()
    }
}

if (-not $DiscordPublicKey) {
    $DiscordPublicKey = Read-Host "Discord application Public Key"
}

$davidToken = New-StrongToken
$nicuToken = New-StrongToken

Write-Host "Installing Worker dependencies..."
npm install

Write-Host "Uploading Worker secrets..."
$DiscordPublicKey | npx wrangler secret put DISCORD_PUBLIC_KEY
$davidToken | npx wrangler secret put INGEST_TOKEN_DAVID
$nicuToken | npx wrangler secret put INGEST_TOKEN_NICU

Write-Host "Deploying Discord/status Worker..."
npx wrangler deploy

Write-Host "Connecting David's GitHub monitor..."
gh secret set STATUS_INGEST_TOKEN -R $repo --body $davidToken

$secureDir = Join-Path $env:LOCALAPPDATA "CodexResetMonitor"
New-Item -ItemType Directory -Force -Path $secureDir | Out-Null
$secureNicu = ConvertTo-SecureString $nicuToken -AsPlainText -Force | ConvertFrom-SecureString
$securePath = Join-Path $secureDir "nicu-ingest-token.dpapi"
Set-Content -LiteralPath $securePath -Value $secureNicu -Encoding UTF8

Write-Host ""
Write-Host "Worker deployed."
Write-Host "Health: $workerUrl/health"
Write-Host "Discord Interactions Endpoint URL:"
Write-Host "$workerUrl/discord"
Write-Host ""
Write-Host "David STATUS_INGEST_TOKEN was installed in GitHub."
Write-Host "Nicu's ingest token was stored locally with Windows DPAPI at:"
Write-Host $securePath
Write-Host "The raw token was not printed."
