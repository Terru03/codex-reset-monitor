# Discord usage commands

This Worker turns the existing Cloudflare Worker into a status cache and Discord Interactions endpoint.

It does **not** call OpenAI. Each GitHub monitor reads its own Codex usage through `codex app-server`, posts a small status snapshot to the Worker, and continues to use the existing Discord webhook for automatic reset alerts.

## Commands

- `/usage-david`
- `/usage-nicu`

Replies are ephemeral and contain both the 5-hour and weekly usage percentages plus the next reset time for each window.

## Security

- David and Nicu use separate Codex auth homes, encrypted auth files, GitHub repositories, encryption keys, and Worker ingest tokens.
- The same Discord webhook may be shared.
- Discord interaction requests are verified with the application's Ed25519 public key.
- By default the Worker restricts slash-command reads to the Discord user stored in `DISCORD_ALLOWED_USER_ID` or the existing `DISCORD_USER_ID` Worker secret.
- The Worker never receives an OpenAI access token or refresh token.

## Discord application setup

1. Create a dedicated application in the Discord Developer Portal.
2. Copy its **Application ID** and **Public Key** from General Information.
3. Copy/reset its **Bot Token** from the Bot page. Keep it private.
4. Install the application in your server with the `applications.commands` scope.
5. Copy your server/guild ID (Developer Mode -> Copy Server ID).
6. Run `setup-worker.ps1` and paste only the Discord **Public Key** when asked.
7. The script deploys the Worker and prints this Interactions Endpoint URL:
   `https://codex-reset-monitor.david-galdea.workers.dev/discord`
8. Paste that URL into the application's **Interactions Endpoint URL** field and save it. Discord will validate it with a signed PING request.
9. Run `register-commands.ps1` and enter the Application ID, Guild ID, and Bot Token locally.

Never paste the Bot Token, webhook URL, Codex auth file, or ingest tokens into chat.

## Existing Cloudflare resources reused

Worker:
`codex-reset-monitor.david-galdea.workers.dev`

KV binding:
`CODEX_STATE`

KV namespace:
`49c67ed97f014efe81df1a10a4df797e`

The former Worker-side OpenAI polling is intentionally removed; Cloudflare was blocked by ChatGPT's WAF. GitHub Actions remains the authoritative Codex reader.
