# Connect your AI to CARSEM

Everything goes through the same gate first: open the web app (`npm run demo` → http://localhost:5173 → **Get started**), **connect your Lace wallet** (preprod testnet; you sign a free one-time message), verify (mock KYC), give consent, and you get a Masumi-compatible DID, a KYC credential, one agent with one platform wallet, and a **CARSEM key** (`csm_…`).

## Codex (ChatGPT's coding agent) and the terminal: one line

```sh
curl -fsSL http://localhost:4021/install.sh | sh && carsem link && carsem codex
```

- `install.sh` puts the `carsem` command in `~/.carsem/bin` (Node.js 20+). The platform serves it, so it always points at that CARSEM.
- `carsem link` opens the web app; sign in with Lace, finish KYC and consent, and the key is sent back to the CLI (saved in `~/.carsem/config.json`; no seed phrase ever touches the terminal).
- `carsem codex` adds `[mcp_servers.carsem]` to `~/.codex/config.toml`. Codex then starts `carsem mcp`, an MCP server on stdio that forwards every CARSEM tool to your agent. Open `codex` and ask: *"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades."*

Also: `carsem status` (account, credit limit, wallet, loan), `carsem ask "…"` (your agent, streamed), `carsem chatgpt` (the connector URL below), `carsem unlink`.

## ChatGPT (web and desktop)

Add a custom connector (Settings → Connectors) with your personal URL; the key is in the path because ChatGPT cannot send custom headers:

```
https://<your-public-gateway>/mcp/k/csm_your_key
```

This needs a public HTTPS URL (ngrok). Bring your history with ChatGPT's data export: import `conversations.json` in the My agent sidebar.

## Credit limit

Every account has a credit score (0–100) and a credit limit (1–50 USDM) that a loan cannot exceed: account age (up to 30 points; the wallet's first on-chain activity on preprod, else the CARSEM account), size of the past-message history (up to 40), variety of sources and intents (up to 20), and repayment record (−10 to +10). `GET /me/credit` shows the breakdown and what raises it.

## curl

```sh
curl -N http://localhost:4031/v1/ask -H "Authorization: Bearer $CARSEM_KEY" -H "Content-Type: application/json" \
  -d '{"message":"Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"}'

curl http://localhost:4031/v1/tools                                   # list tools
curl http://localhost:4031/v1/tools/search_data -H "Authorization: Bearer $CARSEM_KEY" \
  -H "Content-Type: application/json" -d '{"category":"flight","query":"KUL-SIN"}'
```

`npm run demo:user -- --save` onboards a demo user from the terminal (a software wallet stands in for Lace) and saves `CARSEM_KEY` to `.env.local`.
