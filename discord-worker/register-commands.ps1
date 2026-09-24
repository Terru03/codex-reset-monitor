param(
    [string]$ApplicationId,
    [string]$GuildId,
    [string]$BotToken
)

$ErrorActionPreference = "Stop"

if (-not $ApplicationId) { $ApplicationId = Read-Host "Discord Application ID" }
if (-not $GuildId) { $GuildId = Read-Host "Discord Server/Guild ID" }
if (-not $BotToken) {
    $secureBotToken = Read-Host "Discord Bot Token (hidden)" -AsSecureString
    $BotToken = [System.Net.NetworkCredential]::new("", $secureBotToken).Password
}

$commands = @(
    @{
        name = "usage-david"
        type = 1
        description = "Show David's current Codex usage and reset times"
    },
    @{
        name = "usage-nicu"
        type = 1
        description = "Show Nicu's current Codex usage and reset times"
    }
)

$headers = @{
    Authorization = "Bot $BotToken"
    "Content-Type" = "application/json"
}

$body = $commands | ConvertTo-Json -Depth 10
$uri = "https://discord.com/api/v10/applications/$ApplicationId/guilds/$GuildId/commands"

$result = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body

Write-Host ""
Write-Host "Registered Discord commands:"
$result | Select-Object name, id | Format-Table -AutoSize
Write-Host "Commands are guild-scoped, so they should appear immediately."
