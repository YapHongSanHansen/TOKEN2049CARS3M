# Facilitator

CARSEM uses the Cardano Foundation's Java facilitator,
[cardano-foundation/cardano-x402-facilitator](https://github.com/cardano-foundation/cardano-x402-facilitator),
unchanged. It implements the x402 v2 `exact` scheme on Cardano. It answers two
questions for carsem-api: *is this signed payment valid?* (`POST /verify`) and
*did it settle?* (`POST /settle`).

- It **never holds keys** and never signs. The agent signs its own payment, and
  the facilitator checks it and broadcasts it.
- carsem-api talks to it through the official `@x402/core` `HTTPFacilitatorClient`.
  Set `FACILITATOR_URL` (default `http://localhost:4022`).
- It is used only when `CHAIN_MODE=preprod`. In `simulated` mode, carsem-api uses a
  built-in facilitator over its ledger with the same `/supported` contract.

## Run it

You need Docker and a Blockfrost **preprod** project id in the repo's `.env`.

```sh
npm run facilitator:up     # clones the repo (pinned commit), docker compose --profile light up -d --build
curl localhost:4022/supported
npm run facilitator:down
```

The first build compiles the Java service, so it takes a few minutes. The light
profile runs Postgres and the facilitator, and publishes port 4022 on loopback only.

## Two things the facilitator README warns about

- A rejected payment comes back as `200 OK` with `isValid: false`. carsem-api's
  x402 middleware reads the body, not the status.
- `settlement_pending` with a transaction hash does **not** mean the payment
  failed. The agent's x402 client re-sends the *same* signed payment until it
  settles. It never signs a second one.
