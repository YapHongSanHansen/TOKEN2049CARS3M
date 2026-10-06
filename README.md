# CARSEM

> Your agent never stops at a paywall. It borrows against your data, earns while you sleep, and repays itself.

TOKEN2049 · Cardano agentic commerce (x402 + Masumi) · Cardano **preprod** · USDM + tADA

Users talk to **their own AI app** (Hermes, Claude Code, ChatGPT, Claude, or plain `curl`). CARSEM plugs into it over MCP. Before anything works, the user **connects their own Cardano wallet (Lace, preprod testnet)**, verifies with a **Masumi-compatible DID** (KYC + consent), and gets **one agent with its own wallet**.

```
 User ─ chats in Hermes / Claude Code / ChatGPT / Claude / curl
   │      "Find me trading signals on CARSEM, I want pocket money from Cardano DEX trades"
   ▼
 Onboarding gate (once)  connect Lace (CIP-30, sign a CIP-8 message, preprod only) → KYC (mock)
                         → DID + "KYC verified" credential (both name the wallet) → consent
                         → ONE agent + its own wallet (0.05 USDM)
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

Needs Node ≥ 22.13.

```sh
npm install
cp .env.example .env
npm run seed -- --reset
npm run demo        # carsem-api :4021 · agent gateway :4031 · web http://localhost:5173
```

1. Install [Lace](https://www.lace.io) and switch it to **Preprod** (Settings → Network → Preprod). Open **http://localhost:5173 → Get started**, click **Connect Lace** and sign the one-time message (free, no transaction), then verify (mock KYC) and consent. You get your DID, credential, agent, agent wallet and **CARSEM key**. The same wallet always signs you back into the same account.
2. **Connect your AI app** (the page shows copy-paste setup for each; details in [integrations/README.md](integrations/README.md)):
   - Hermes: add the `carsem` MCP server to a `carsem` profile.
   - Claude Code: `claude mcp add --transport http carsem http://localhost:4031/mcp --header "Authorization: Bearer csm_…"`
   - ChatGPT / Claude web: custom connector `https://<public gateway>/mcp/k/csm_…` (needs ngrok).
   - curl: `curl -N http://localhost:4031/v1/ask -H "Authorization: Bearer csm_…" -H "Content-Type: application/json" -d '{"message":"Find me trading signals on CARSEM"}'`
3. Open **My agent**, a Claude-style chat. Your past messages are in the sidebar (import a ChatGPT/Claude export, or **Add sample chats** for the demo). Ask for trading signals, the cheapest KL→Singapore flight, a Geylang hotel or the Pokémon 30th Anniversary pack. When the agent can't afford the data it asks to borrow, and **you tick which past messages to pledge** right in the chat. Conversations from Hermes, Claude Code, ChatGPT and curl show up in the same chat.

For a quick default demo, start with `LOAN_DEADLINE_SECONDS=60 npm run demo`. From the terminal only: `npm run demo:user -- --save`, then `npm run ask -- "Trade MIN for me"`.

**Simulated vs real.** Everything above the chain is real: the official x402 SDKs on both sides, offers, signed payloads, verify/settle, receipts, the lending rules, DIDs and signed credentials, redaction and the MCP server. Only the chain is replaced, by a local signed ledger, until you switch to `CHAIN_MODE=preprod`. The DEX trade is a labelled simulated fill, and KYC is a labelled mock.

## Wallets (Masumi roles)

| Wallet | Who holds it | What it does |
|---|---|---|
| **Your Lace wallet** | you (CIP-30 browser wallet, preprod) | Your sign-in and identity, proven with CIP-8 `signData` and written into your DID document (`authentication`) and KYC credential. It tops up your agent and receives your earnings: your **collection wallet** in Masumi terms. |
| **Your agent's wallet** | the CARSEM gateway (encrypted, one per user) | Pays for data over x402 by itself, so ChatGPT, Claude and curl never wait for a wallet popup: the agent's **purchasing wallet**. |

Mainnet wallets are refused: CARSEM runs on the Cardano **preprod testnet**. On the simulated chain your Lace wallet is used for identity only; funds move between the wallets once `CHAIN_MODE=preprod`.

The web app connects Lace with the Cardano Foundation's [`cardano-connect-with-wallet`](https://github.com/cardano-foundation/cardano-connect-with-wallet) core (`Wallet.connect` limited to testnet, then `Wallet.signMessage`), as in the Cardano developer portal's Evolution + Vite + React template. carsem-api verifies the CIP-8 signature with Evolution SDK.

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
| `frontend/` | Web (React + Tailwind + shadcn/ui + beui chat components): Get started (gate + connect), My agent (chat; the agent answers in OpenUI Lang, rendered with `@openuidev/react-lang`), CARSEM dashboard, Market (one daisy per seller) |
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

ChatGPT / Claude web connectors need a public HTTPS URL for the gateway: run `ngrok http 4031` yourself and set `GATEWAY_PUBLIC_URL` to the URL it gives you. (`NGROK_AUTHTOKEN` / `NGROK_DOMAIN` in `.env.local` are placeholders; no code reads them yet.)

## Where we are now (7 Oct 2026)

**The whole loop runs end to end on the simulated chain.** `npm run typecheck` is clean and `npm test` passes **13/13**: wallet sign-in (Lace, CIP-8), onboarding gate, the full flow over MCP, curl, default → published → keeps selling, x402 + MIP-003, redaction. **The preprod code path has been written but never run against preprod yet**, because the keys aren't in: `.env.local` has the generated treasury/enterprise wallets and secrets, but `BLOCKFROST_PROJECT_ID`, `OPENAI_*` and `NGROK_*` are still empty.

Progress against [CARSEM_BUILD_PLAN.md](CARSEM_BUILD_PLAN.md):

| Plan step | State | Notes |
|---|---|---|
| 1 Environment & wallets | ◐ half | Treasury + enterprise mnemonics generated (`npm run wallets:new`). No Blockfrost project yet, wallets not funded. |
| 2 x402 | ✅ done | Official `@x402/core` + `@x402/cardano` on both sides instead of forking the demo. A built-in facilitator for simulated mode; `npm run facilitator:up` runs the Java facilitator for preprod. |
| 3 Masumi | ◐ partial | Done: the user's Lace wallet signs them in (CIP-30 + CIP-8, preprod only) and is bound to their DID and KYC credential; MIP-003 endpoints (`/availability`, `/input_schema`, `/start_job`, `/status`) paid over x402, W3C DIDs and a signed KYC credential. **Not built:** registering CARSEM and the agents on the Masumi registry, and Masumi escrow. |
| 4 Data marketplace | ✅ done | Signals plus flight, hotel and product prices; user uploads; ratings build uploader reputation. |
| 5 Agent wallet + x402 client | ✅ done | One encrypted wallet per user, held by the gateway, which signs x402 payments (Masumi's purchasing wallet). The user's own Lace wallet is their collection wallet. |
| 6 CARSEM Lending | ✅ done (ledger) | Loan requests, user-picked collateral (≥ `MIN_PLEDGE_ITEMS`), 2% fee, deadline, repay, default checker. Collateral is locked by CARSEM's ledger. **Aiken loan validator not started.** |
| 7 Redaction + consent | ✅ mostly | Revocable consent screen, redaction on arrival. `POST /redact/preview` exists, but there's no before/after view in the UI yet. |
| 8 Agent brain | ✅ done | MCP server with 14 tools (Hermes, Claude Code, ChatGPT, Claude), curl `/v1/ask`, OpenAI brain or a scripted brain when there's no key. |
| 9 DEX trade | ◐ simulated | Labelled simulated fill, with profit paid by the market-maker wallet. **Minswap SDK not wired.** |
| 10 Enterprise market | ✅ done | eBay / Amazon / BNB / Meta bids. A private sale while a loan is open repays it; after a default the bundle is public for a fee. |
| 11 Frontend | ✅ done | Get started · My agent (Claude-style chat, message picking) · CARSEM dashboard · Market, with explorer links on chain actions. |
| 12 Submission | ◐ in progress | README is up to date. Demo video (≤ 3 min) and write-up not done. |

Proof of delivery is a label-674 metadata transaction from the CARSEM treasury: on the local ledger now, on preprod once it's live. It does not go through Masumi's decision log yet.

### Next up

1. **First live preprod run.** Create a Blockfrost preprod project, fund the treasury (≥ 50 tADA, ≥ 20 tUSDM) and enterprise (≥ 5 / 5) wallets, `npm run facilitator:up` (needs Docker), `CHAIN_MODE=preprod`, `npm run preflight`, then demo.
2. **Public URL** (ngrok → `GATEWAY_PUBLIC_URL`) so ChatGPT / Claude web connectors work.
3. **Masumi:** registry registration for CARSEM and the agents, then escrow.
4. **Minswap preprod swap**, keeping the simulated fill as a fallback.
5. **Lace funding on preprod:** top up the agent's wallet from Lace (the backend builds the transaction, Lace signs it) and pay earnings to it.
6. **Aiken loan validator** to lock collateral on chain instead of in CARSEM's ledger.
7. **Redaction before/after view** in the UI.
8. **Demo video + write-up.**

Check it yourself: `npm run typecheck && npm test`.
