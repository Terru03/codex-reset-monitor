param(
    [string]$ApplicationId,
    [string]$GuildId,
    [string]$BotToken
)

$ErrorActionPreference = "Stop"

if (-not $ApplicationId) {
    $ApplicationId = Read-Host "Discord Application ID"
}

if (-not $GuildId) {
    $GuildId = Read-Host "Discord Server/Guild ID"
}

if ($ApplicationId -notmatch '^\d{17,20}$') {
    throw "ApplicationId must be the real numeric Discord Application ID."
}

if ($GuildId -notmatch '^\d{17,20}$') {
    throw "GuildId must be the real numeric Discord Server ID, not a placeholder."
}

if (-not $BotToken) {
    $secureBotToken = Read-Host "Discord Bot Token (hidden)" -AsSecureString
    $BotToken = [System.Net.NetworkCredential]::new("", $secureBotToken).Password
}

if ([string]::IsNullOrWhiteSpace($BotToken)) {
    throw "Discord Bot Token cannot be empty."
}

$headers = @{
    Authorization = "Bot $BotToken"
    "User-Agent" = "DiscordBot (https://github.com/Terru03/codex-reset-monitor, 1.0)"
    Accept = "application/json"
}

Write-Host "Checking Discord bot token..."
try {
    $me = Invoke-RestMethod -Method Get -Uri "https://discord.com/api/v10/users/@me" -Headers $headers
}
catch {
    throw "Discord rejected the bot token/API request. $($_.Exception.Message)"
}

if ([string]$me.id -ne [string]$ApplicationId) {
    throw "Bot token belongs to Discord application $($me.id), not ApplicationId $ApplicationId."
}

Write-Host "Bot token OK: $($me.username) ($($me.id))"

Write-Host "Checking that the bot is installed in guild $GuildId..."
try {
    $guild = Invoke-RestMethod -Method Get -Uri "https://discord.com/api/v10/guilds/$GuildId" -Headers $headers
}
catch {
    throw "The bot cannot access guild $GuildId. Install the app into that server with bot + applications.commands scopes, then retry. $($_.Exception.Message)"
}

Write-Host "Guild access OK: $($guild.name)"

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

$headers["Content-Type"] = "application/json"
$body = $commands | ConvertTo-Json -Depth 10
$uri = "https://discord.com/api/v10/applications/$ApplicationId/guilds/$GuildId/commands"

Write-Host "Registering guild slash commands..."
try {
    $result = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -Body $body
}
finally {
    $BotToken = $null
    Remove-Variable secureBotToken -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Registered Discord commands:"
$result | Select-Object name, id | Format-Table -AutoSize
Write-Host "Commands are guild-scoped, so they should appear immediately."
