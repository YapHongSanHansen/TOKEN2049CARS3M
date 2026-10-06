# Connect your AI app to CARSEM

Every app goes through the same gate first: open the web app (`npm run demo` → http://localhost:5173 → **Get started**), verify (mock KYC), give consent, and you get a Masumi-compatible DID, a KYC credential, one agent with one platform wallet, and a **CARSEM key** (`csm_…`). The gateway URL below is `http://localhost:4031` locally, or your ngrok URL once CARSEM is public.

| App | How it connects | Brain |
|---|---|---|
| Hermes | MCP over HTTP, key in a header | yours (any model, e.g. OpenAI via `hermes model`) |
| Claude Code | MCP over HTTP, key in a header | Claude |
| ChatGPT / Claude (web, desktop) | custom connector with your personal URL | ChatGPT / Claude |
| Terminal | `curl` | CARSEM's built-in brain (OpenAI if `OPENAI_API_KEY` is set, otherwise scripted) |

## Hermes

Use a separate profile so other Hermes setups (e.g. a Telegram bot with its own persona) are untouched:

```sh
hermes profile create carsem
```

Add to that profile's `config.yaml` (Windows: `%LOCALAPPDATA%\hermes\profiles\carsem\config.yaml`):

```yaml
mcp_servers:
  carsem:
    url: http://localhost:4031/mcp
    headers:
      Authorization: "Bearer csm_your_key"
```

Optionally copy `integrations/skills/carsem/` into the profile's `skills/` folder, then run `hermes -p carsem` and ask: *"Find me the information of trading signals on CARSEM, I would like to make some extra pocket money on Cardano DEX trades."*

Sync what Hermes knows about you (memories + your messages, redacted on your machine): `npm run sync -- --source hermes --profile carsem --yes`.

## Claude Code

```sh
claude mcp add --transport http carsem http://localhost:4031/mcp --header "Authorization: Bearer csm_your_key"
```

Optionally copy `integrations/skills/carsem/` to `~/.claude/skills/carsem/`. Sync your Claude Code history: `npm run sync -- --source claude-code --yes`.

## ChatGPT and Claude (web and desktop)

Add a custom connector with your personal URL (the key is in the path because these apps cannot send custom headers):

```
https://<your-public-gateway>/mcp/k/csm_your_key
```

This needs a public HTTPS URL (ngrok). Custom connectors depend on your ChatGPT / Claude plan. Bring your history with the app's data export, then `npm run sync -- --source chatgpt-export --path conversations.json --yes` (or `claude-export`).

## curl

```sh
curl -N http://localhost:4031/v1/ask -H "Authorization: Bearer $CARSEM_KEY" -H "Content-Type: application/json" \
  -d '{"message":"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"}'

curl http://localhost:4031/v1/tools                                   # list tools
curl http://localhost:4031/v1/tools/search_data -H "Authorization: Bearer $CARSEM_KEY" \
  -H "Content-Type: application/json" -d '{"category":"flight","query":"KUL-SIN"}'
```

`npm run demo:user -- --save` onboards a demo user from the terminal and saves `CARSEM_KEY` to `.env.local`; then `npm run ask -- "…"` and `npm run tool -- search_data '{"category":"hotel","query":"Geylang"}'` work too.
