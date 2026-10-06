---
name: carsem
description: Use CARSEM on Cardano to buy trading signals or live flight / hotel / product prices over x402, with collateral borrowing against the user's redacted chats when the agent wallet is short. Use when the user asks for trading signals, cheapest flights, hotels or products, or about their CARSEM loan.
---

# CARSEM

CARSEM is a data platform built on Masumi: trading signals for Cardano DEX tokens and live flight / hotel / product prices, paid per request over x402 in USDM. The CARSEM MCP server gives you these tools: `carsem_status`, `search_data`, `buy_data`, `list_my_messages`, `add_messages`, `borrow`, `borrow_status`, `trade_signal`, `my_loan`, `repay_loan`, `upload_data`, `rate_data`, `browse_published_data`, `access_published_data`.

## Workflow

1. Call `carsem_status` first. If the user is not onboarded, give them the onboarding link (Masumi DID verification: KYC + consent) and stop.
2. `search_data` for what the user needs, then `buy_data`.
3. If `buy_data` returns `insufficient_funds`, use collateral borrowing. Call `borrow` with the price and a short purpose. It returns `selection_required` with a `request_id` and the user's past messages. **Show the user those messages and ask which ones to pledge** (at least `minimum_to_pledge`). Then call `borrow` again with their `message_ids` and the `request_id`. Never pick for them. If you can't ask (a one-shot run), call `borrow_status` with `wait_seconds: 600`, and the user chooses in the CARSEM web chat (`approve_in_app`). If they have too few messages, offer to `add_messages` with short factual lines you know about them (CARSEM redacts names, dates and contacts on arrival). Borrow at most once per task.
4. `buy_data` again. For a trading signal, `trade_signal` with its `delivery_id`.
5. If you borrowed and the wallet now covers the loan, `repay_loan`. Otherwise tell the user exactly how much to top up and the deadline, and that if the loan isn't repaid, the messages they pledged are published on CARSEM for any user to buy.
6. Summarise what was bought, borrowed, traded and repaid, with transaction hashes.

## Adding more past messages

To have more messages to choose from, the user can import a ChatGPT/Claude export in the CARSEM web chat, or run this from the CARSEM repo (everything is redacted on their machine before upload):

```sh
npm run sync -- --source hermes --profile carsem --yes     # Hermes memories + chats
npm run sync -- --source claude-code --yes                 # Claude Code history
npm run sync -- --source chatgpt-export --path conversations.json --yes
```
