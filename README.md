# CARSEM

> Your agent never stops at a paywall. It borrows against your data, earns while you sleep, and repays itself.

TOKEN2049 · Cardano agentic commerce (x402 + Masumi) · Cardano **preprod** · USDM + tADA

Users talk to **their own AI app** (Hermes, Claude Code, ChatGPT, Claude, or plain `curl`). CARSEM plugs into it over MCP. Before anything works, the user verifies with a **Masumi-compatible DID** (KYC + consent) and gets **one agent with one platform wallet**.

```
 User ─ chats in Hermes / Claude Code / ChatGPT / Claude / curl
   │      "Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"
   ▼
 Onboarding gate (once)  KYC (mock) → DID + "KYC verified" credential → consent → ONE agent + ONE wallet (0.05 USDM)
   │
   ▼
 AI Agent ── MCP ──▶ CARSEM agent gateway (holds the user's wallet, signs x402)
   │ 1 search CARSEM ─────────────────────▶ CARSEM platform: signals · flight · hotel · product prices
   │◀─ 2 x402: pay 5 USDM ─────────────────    (uploaded by users, not validated, reputation over time)
   │ 3 check balance: 0.05 < 5
   │ 4 collateral borrowing ──────────────▶ the agent ASKS; the user CHOOSES which past messages to pledge
   │                                         (redacted, LOCKED as collateral); treasury pays 5 USDM on chain
   │ 5 pay 5 USDM via x402 → get data ────▶ proof of delivery: hash(request + data) logged on chain
   │   trade the signal (DEX, simulated) → profit → repay via x402 → collateral released
   ▼
 Else default ─▶ the pledged (redacted) messages are PUBLISHED on CARSEM: any verified user can access them for a fee,
                 enterprises (eBay 50 · Amazon 25 · BNB 10 · Meta 5) can buy them, and they keep selling.
 While a loan is open, enterprises may buy the locked chats privately (if the user allowed it): proceeds repay the loan.
```

## Run it (simulated chain, no keys needed)

```sh
npm install
cp .env.example .env
npm run seed -- --reset
npm run demo        # carsem-api :4021 · agent gateway :4031 · web http://localhost:5173
```

1. Open **http://localhost:5173 → Get started**: create an account, verify (mock KYC), consent. You get your DID, credential, agent, wallet and **CARSEM key**.
2. **Connect your AI app** (the page shows copy-paste setup for each; details in [integrations/README.md](integrations/README.md)):
   - Hermes: add the `carsem` MCP server to a `carsem` profile.
   - Claude Code: `claude mcp add --transport http carsem http://localhost:4031/mcp --header "Authorization: Bearer csm_…"`
   - ChatGPT / Claude web: custom connector `https://<public gateway>/mcp/k/csm_…` (needs ngrok).
   - curl: `curl -N http://localhost:4031/v1/ask -H "Authorization: Bearer csm_…" -H "Content-Type: application/json" -d '{"message":"Find me trading signals on CARSEM"}'`
3. Open **My agent**, a Claude-style chat. Your past messages are in the sidebar (import a ChatGPT/Claude export, or **Add sample chats** for the demo). Ask for trading signals, the cheapest KL→Singapore flight, a Geylang hotel or the Pokémon 30th Anniversary pack. When the agent can't afford the data it asks to borrow, and **you tick which past messages to pledge** right in the chat. Conversations from Hermes, Claude Code, ChatGPT and curl show up in the same chat.

For a quick default demo, start with `LOAN_DEADLINE_SECONDS=60 npm run demo`. From the terminal only: `npm run demo:user -- --save`, then `npm run ask -- "Trade MIN for me"`.

**Simulated vs real.** Everything above the chain is real: the official x402 SDKs on both sides, offers, signed payloads, verify/settle, receipts, the lending rules, DIDs and signed credentials, redaction and the MCP server. Only the chain is replaced, by a local signed ledger, until you switch to `CHAIN_MODE=preprod`. The DEX trade is a labelled simulated fill, and KYC is a labelled mock.

## Where the data comes from ("the AI agent has the user's information")

Nothing is collected before the user consents, and everything is redacted on arrival (people, dates, phones, emails, addresses and accounts removed; health topics and credentials withheld). Places and products are kept, because that's what the data is worth. Each borrow pledges **only the messages the user picks** (at least `MIN_PLEDGE_ITEMS`, default 3); those are sealed (encrypted) as that loan's collateral and unlocked on repayment. The agent never picks for the user: with MCP it shows the list and asks, and with curl or a one-shot run it waits while the user chooses in the web chat.

| Source | How |
|---|---|
| Every prompt | what you ask your agent (any app) becomes one of your past messages |
| The AI app itself | the `add_messages` tool: the AI adds what it knows about you from the chat and its memory |
| Web chat | **Import ChatGPT / Claude export** (conversations.json) or **Add sample chats (demo)** in the sidebar |
| Hermes | `npm run sync -- --source hermes --profile carsem --yes` (memories + your messages, redacted locally) |
| Claude Code | `npm run sync -- --source claude-code --yes` |
| ChatGPT / Claude | export your data, then `npm run sync -- --source chatgpt-export --path conversations.json --yes` |

## Packages

| Path | What |
|---|---|
| `carsem-api/` | The platform: onboarding gate (KYC, DID, credential, consent), data platform + x402 paywall, past messages, loan requests + lending, market, DEX simulator, Masumi MIP-003 endpoints |
| `agent/` | The agent gateway: hosted wallets (one per user, encrypted), the CARSEM MCP server, curl API, OpenAI/scripted brain, `sync` / `ask` / `tool` / `demo:user` CLIs |
| `frontend/` | Web: Get started (gate + connect), My agent (Claude-style chat with message picking for loans), CARSEM dashboard, Market |
| `shared/` | Units, redaction, encryption, simulated-chain transactions |
| `integrations/` | How to connect Hermes, Claude Code, ChatGPT/Claude, curl; a `carsem` skill |
| `facilitator/` | Runs the Java cardano-x402-facilitator (Docker) for preprod |
| `tests/` | End-to-end tests with a real MCP client (`npm test`) |

## Real preprod

Put your keys in **`.env.local`** (gitignored; it already holds the generated platform wallets and secrets), then:

1. `BLOCKFROST_PROJECT_ID`: a *Cardano preprod* project at blockfrost.io.
2. `npm run wallets:new` prints the treasury and enterprise addresses. Fund them with tADA from the [faucet](https://docs.cardano.org/cardano-testnets/tools/faucet) and tUSDM from the [Masumi dispenser](https://dispenser.masumi.network). Users' agent wallets are created and funded by CARSEM.
3. With Docker running: `npm run facilitator:up` (the [Java x402 facilitator](https://github.com/cardano-foundation/cardano-x402-facilitator)).
4. `CHAIN_MODE=preprod` in `.env`, then `npm run preflight`. It lists anything missing.
5. `npm run seed -- --reset && npm run demo`.

For ChatGPT / Claude web connectors and Masumi registry registration, CARSEM needs a public URL: set `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`.

## Status

| Drawing | State |
|---|---|
| Chat in the user's own AI app (Hermes, Claude Code, ChatGPT, Claude, curl) | done: MCP server + curl API |
| Masumi DIDs / verifiable credentials, KYC, one platform wallet | done: W3C DIDs + signed KYC credential (mock KYC), one identity → one account → one wallet; **Masumi registry registration needs the public URL** |
| 1–3 search, x402 402, balance 0.05 < 5 | done |
| 4 collateral borrowing, collateral locked | done: the user chooses the past messages to pledge (locked by CARSEM's ledger; an Aiken loan contract is next) |
| 5 pay via x402 → data; decision logging → proof of delivery | done: hash logged on chain; **Masumi escrow + Masumi's decision log need preprod + registry** |
| Signals or flight/hotel prices, user uploads, reputation | done |
| Else default: published for all users for a fee, keeps selling | done |
| Enterprises buy data (private while a loan is open) | done |
| Real Cardano preprod | ready, needs your keys |

Tests: `npm run typecheck && npm test`.
