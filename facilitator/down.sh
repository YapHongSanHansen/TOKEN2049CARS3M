#!/bin/sh
set -e
cd "$(dirname "$0")/cardano-x402-facilitator/deploy"
docker compose --profile light down
