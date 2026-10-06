#!/bin/sh
# Runs the Cardano Foundation's Java x402 facilitator (Postgres + facilitator,
# the "light" Compose profile) on http://localhost:4022 for CHAIN_MODE=preprod.
# It holds no keys: it verifies payer-signed transactions and broadcasts them.
set -e
cd "$(dirname "$0")"
REPO_URL=https://github.com/cardano-foundation/cardano-x402-facilitator
# The commit this backend was built against.
REF=97add9f8446630355d77f86c3d040c56e15ca5e4
DIR=cardano-x402-facilitator

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO_URL" "$DIR"
  git -C "$DIR" checkout --quiet "$REF"
fi

PROJECT_ID=$(grep -E '^BLOCKFROST_PROJECT_ID=' ../.env 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)
case "$PROJECT_ID" in
  preprod*) ;;
  *) echo "Set BLOCKFROST_PROJECT_ID (a preprod project id) in the repo's .env first." >&2; exit 1 ;;
esac

cd "$DIR/deploy"
[ -f .env ] || cp .env.example .env
grep -v '^BLOCKFROST_PROJECT_ID=' .env > .env.tmp || true
echo "BLOCKFROST_PROJECT_ID=$PROJECT_ID" >> .env.tmp
mv .env.tmp .env

docker compose --profile light up -d --build

echo "Waiting for http://localhost:4022/supported ..."
i=0
while [ $i -lt 60 ]; do
  if curl -sf http://localhost:4022/supported; then echo; exit 0; fi
  i=$((i + 1)); sleep 5
done
echo "The facilitator did not come up. Logs: (cd facilitator/$DIR/deploy && docker compose --profile light logs facilitator)" >&2
exit 1
