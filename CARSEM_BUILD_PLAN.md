# CARSEM — Build Plan (step by step)

> **One-liner:** Your agent never stops at a paywall. It borrows against your data, earns while you sleep, and repays itself.
>
> **Track:** TOKEN2049 — Cardano agentic commerce (x402 + Masumi)
> **Network:** Cardano **preprod** testnet · **Currency:** tUSDM (test USDM) + tADA for fees

---

## 0. What we're building (MVP scope)

The one loop the demo must show, end to end, on preprod:

```
User asks agent for trading signals
 → 1. Agent requests signal from CARSEM
 → 2. CARSEM replies HTTP 402 (x402): pay 5 USDM
 → 3. Agent checks wallet: 0.05 USDM < 5  → not enough
 → 4. Agent borrows 5 USDM from CARSEM Lending (collateral = rights to user's redacted chats)
 → 5. Agent pays 5 USDM via x402 (Masumi escrow) → receives signal (delivery hash logged on-chain)
 → 6. Agent swaps on a Cardano DEX (Minswap, preprod) → earns
 → 7a. Agent repays → collateral released            (green path)
 → 7b. Deadline passes, no repay → redacted chats listed on CARSEM behind a paywall (red path)
 + Enterprises can buy redacted chat bundles while a loan is open
```

**Everything else is stretch.** If time runs out, cut from the bottom of section 3 upward.

### Masumi features we use (and only these)
| Feature | Where |
|---|---|
| Agent registry / identity (DID) | The AI agent and CARSEM are both registered on Masumi |
| Escrow payments | Step 5: data purchase goes through Masumi escrow |
| Decision logging | Step 5: hash(request + delivered signal) on-chain = proof of delivery |

> ⚠️ Masumi has **no lending primitive**. CARSEM Lending is *our* contribution — pitch it that way.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node 20+) everywhere | x402 Cardano demo, Masumi payment service, Minswap SDK are all TS |
| Starting template | [`cardano-foundation/x402-cardano-demo`](https://github.com/cardano-foundation/x402-cardano-demo) | Already has server + facilitator + frontend, **tUSDM payments and a Masumi-escrow route on preprod** |
| Chain access | Blockfrost (preprod project ID) | Required by the demo + Masumi |
| Masumi | `masumi-network/masumi-payment-service` (Node, Postgres, Prisma, MeshSDK) | Registry, escrow, decision logging |
| DEX | `@minswap/sdk` (has a preprod swap example) | Step 6 |
| Agent brain | Any LLM with tool-calling (Claude / OpenAI) | Agent decides: fetch → borrow → pay → trade → repay |
| DB | Postgres (already needed by Masumi) | Loans, signals, uploaders, bids |
| Redaction | LLM prompt or Microsoft Presidio | Strip names / PII before any sale |
| Frontend | React (from the demo) | Chat UI + CARSEM dashboard |

### Repo layout (monorepo)
```
carsem/
├── facilitator/        # from x402-cardano-demo (unchanged at first)
├── carsem-api/         # x402 seller: trading signals + data marketplace + lending
├── agent/              # LLM agent + wallet + tools
├── frontend/           # chat UI + CARSEM dashboard + enterprise view
├── contracts/          # (stretch) Aiken loan validator
├── scripts/            # seed data, fund wallets, demo reset
└── docs/               # write-up, architecture diagram, demo script
```

---

## 2. Step-by-step build

Each step has a **Done when** check. Don't start the next step until it passes.

### Step 1 — Environment & wallets
- [ ] Create a Blockfrost **preprod** project → get project ID
- [ ] Create 3 preprod wallets: `AGENT`, `CARSEM_TREASURY` (lender + seller), `USER` (for top-ups)
- [ ] Fund all 3 with tADA from the [Cardano testnet faucet](https://docs.cardano.org/cardano-testnets/tools/faucet)
- [ ] Get tUSDM into `CARSEM_TREASURY` (⚠️ check Masumi docs / Discord for the tUSDM faucet or swap route)
- [ ] Leave `AGENT` with **0.05 tUSDM** — this is the "not enough money" moment

**Done when:** you can see all three balances on a preprod explorer (e.g. preprod.cardanoscan.io).

### Step 2 — Run the x402 Cardano demo untouched
```bash
git clone https://github.com/cardano-foundation/x402-cardano-demo carsem
cd carsem
./setup.sh
# fill facilitator/.env + frontend/.env (Blockfrost ID), server/.env (receiving address)
npm run dev        # frontend :5173 · server :4021 · facilitator :4022
```
- [ ] Pay the **0.10 tUSDM** route and the **Masumi escrow** route from the browser

**Done when:** both payments settle on preprod and the protected resource unlocks. You now understand the x402 flow.

### Step 3 — Run Masumi payment service + register agents
- [ ] Clone and run `masumi-payment-service` (Postgres + `pnpm dev`, migrations via `pnpm run prisma:migrate:dev`)
- [ ] Register **CARSEM** as an agentic service (seller) on the Masumi registry (preprod)
- [ ] Register the **AI Agent** (buyer identity) — this is the "Masumi DID" box on the diagram
- [ ] Implement the Agentic Service API on `carsem-api`: `POST /start_job`, `GET /status`, `GET /availability` ([spec](https://docs.masumi.network/technical-documentation/agentic-service-api))

**Done when:** CARSEM shows up in the Masumi registry and `/availability` returns `available`.

### Step 4 — CARSEM signal marketplace (seller side)
- [ ] Table `uploaders(id, name, reputation)` and `signals(id, uploader_id, token, direction, confidence, created_at, outcome)`
- [ ] `scripts/seed.ts`: 5 fake uploaders, ~50 signals for preprod tokens (e.g. MIN/ADA)
- [ ] `GET /signals/latest?token=MIN` → protected by x402, price **5 tUSDM**, paid via the Masumi escrow route
- [ ] On delivery: submit **hash(request + signal)** as the job result → Masumi decision log
- [ ] Reputation: after the trade window, mark signal `outcome` (hit/miss) → update uploader reputation

**Done when:** `curl` without payment → `402`; paying from the demo frontend → signal JSON + a result hash on-chain.

### Step 5 — Agent wallet + x402 client
- [ ] `agent/wallet.ts`: load `AGENT` key, `getBalance()` for tUSDM
- [ ] `agent/x402Client.ts`: request resource → parse 402 offer → build/sign tx → retry with payment header (reuse the demo's frontend logic, server-side)
- [ ] Fund `AGENT` with 5 tUSDM *temporarily* and confirm the agent can buy a signal by itself

**Done when:** a script `npm run agent:buy` buys a signal with no browser.

### Step 6 — CARSEM Lending (our contribution)
MVP version is **off-chain ledger + on-chain transfers** (honest, demo-able, fast):
- [ ] Table `loans(id, agent_id, user_id, amount, fee, deadline, status[open|repaid|defaulted], collateral_ref)`
- [ ] `POST /loans` → checks agent's Masumi identity → creates loan → `CARSEM_TREASURY` sends 5 tUSDM to `AGENT` → returns tx hash
- [ ] `collateral_ref` = hash of the user's **redacted** chat bundle (store the bundle encrypted)
- [ ] `POST /loans/:id/repay` → verifies an incoming tx from `AGENT` → status `repaid` → collateral released
- [ ] Cron `checkDefaults()` → past deadline + not repaid → status `defaulted` → bundle listed on CARSEM behind a paywall
- [ ] Use a **short deadline (e.g. 5 min)** so the default path can be shown live

**Done when:** you can run borrow → repay, and borrow → wait → default, and both statuses show correctly.

> Stretch: replace the ledger with an **Aiken validator** that locks the loan with a deadline datum (`contracts/`).

### Step 7 — Redaction + consent
- [ ] Opt-in screen (not just T&C): *"Allow my agent to borrow against my redacted chat data"* with a toggle to revoke
- [ ] `redact(chats)` → removes names, birthdays, addresses, third-party info → produces the bundle
- [ ] Show **before / after** in the UI (judges love this)

**Done when:** "My girlfriend's birthday on 30th Sept" becomes something like "[PERSON] birthday gift — budget intent".

### Step 8 — The agent brain (tool-calling loop)
Tools the LLM can call:
```
get_signal(token)       # x402 purchase from CARSEM
check_balance()
borrow(amount)          # CARSEM Lending
execute_trade(signal)   # Minswap preprod swap
repay(loan_id)
```
- [ ] System prompt: *buy signal → if insufficient balance, borrow → pay → trade → repay if profit ≥ loan + fee, else notify user to top up*
- [ ] Log every tool call to the UI so judges can watch the agent "think"

**Done when:** one user message triggers the whole chain with no manual clicks.

### Step 9 — DEX trade (Minswap preprod)
- [ ] `npm i @minswap/sdk` → adapt its **preprod swap example** (`DexV2`, `createBulkOrdersTx`) — needs Node `--experimental-wasm-modules`
- [ ] `execute_trade` swaps a small amount based on the signal direction
- [ ] **Fallback:** if preprod liquidity is thin, simulate the fill and say so on screen

**Done when:** a real (or clearly labelled simulated) swap tx appears in the agent log.

### Step 10 — Enterprise data marketplace
- [ ] Table `bids(enterprise, price_usdm, data_amount)` seeded with eBay 50 / Amazon 25 / BNB 10 / Meta 5
- [ ] Enterprise view: list of **redacted** bundles from open loans → "Buy" via x402
- [ ] Revenue goes to the loan → can **auto-repay** (closes the "earn" story)

**Done when:** buying a bundle reduces the outstanding loan.

### Step 11 — Frontend polish
- [ ] Chat screen (left) · Agent activity log (middle) · Wallet + loan status (right)
- [ ] CARSEM dashboard: signals, uploader reputation, loans, defaulted bundles
- [ ] Every on-chain action shows a clickable preprod explorer link

### Step 12 — Submission
- [ ] **Working prototype on Cardano** (preprod) ✅ from steps 2–11
- [ ] **Open-source repo + docs**: README (setup, env vars, architecture diagram, how to run the demo)
- [ ] **Demo video ≤ 3 min** (script below)
- [ ] **Short write-up**: problem · technical approach (x402, Masumi registry/escrow/decision logging, Minswap, Blockfrost, Aiken if done) · how it scales in the real world

---

## 3. Priority if time is short

| Must have | Should have | Nice to have |
|---|---|---|
| Steps 1–6, 8 | Step 7 (redaction), Step 9 real swap | Step 10 enterprise buy, Aiken validator, reputation updates |

---

## 4. 3-minute demo script

| Time | Show |
|---|---|
| 0:00–0:20 | Problem: agents stall at paywalls when the wallet is empty — usually while you sleep |
| 0:20–0:40 | User opts in, sees redaction before/after |
| 0:40–1:40 | One message → agent hits 402 → balance 0.05 → borrows 5 USDM → pays via Masumi escrow → gets signal (show on-chain hash) |
| 1:40–2:10 | Agent swaps on Minswap → repays → collateral released |
| 2:10–2:40 | Second run: no repay → deadline → redacted bundle listed on CARSEM / enterprise buys it |
| 2:40–3:00 | Architecture slide: x402 + Masumi (identity, escrow, decision logging) + CARSEM Lending |

---

## 5. Open questions / risks to check early

- [ ] **tUSDM faucet** — how to get test USDM on preprod (ask in Masumi / Cardano Discord on day 1)
- [ ] **Masumi escrow route** in the x402 demo vs. the Masumi payment service — confirm which one handles the decision-log hash
- [ ] **Minswap preprod liquidity** — test a swap on day 1; keep the simulated fallback ready
- [ ] **Loan fee / interest** — decide a number (e.g. 2%) so "repay if profit ≥ loan + fee" is concrete
- [ ] **Judges' privacy question** — have the answer ready: opt-in, redaction, revocable, no raw chats ever leave the user

---

## References
- x402 Cardano demo — https://github.com/cardano-foundation/x402-cardano-demo
- x402 Cardano mechanism package — https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/cardano
- Masumi docs — https://docs.masumi.network
- Masumi Agentic Service API — https://docs.masumi.network/technical-documentation/agentic-service-api
- Masumi refunds & disputes — https://docs.masumi.network/core-concepts/refunds-and-disputes
- Minswap SDK — https://github.com/minswap/sdk
