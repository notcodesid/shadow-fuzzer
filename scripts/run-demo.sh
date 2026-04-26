#!/usr/bin/env bash
# Shadow Fuzzer end-to-end demo runner.
#   1. Build the vulnerable vault program
#   2. Start (or assume) a local validator + deploy
#   3. Run the local exploit suite (proves bugs are real)
#   4. Snapshot, provision a private sandbox, and fuzz from a black-box pov
#   5. Print the report path
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "→ creating .env from .env.example (fill in keys before --sandbox=magicblock)"
  cp .env.example .env
fi

if [ ! -f .shadow-fuzzer/fuzz-payer.json ]; then
  mkdir -p .shadow-fuzzer
  solana-keygen new --no-bip39-passphrase --silent --outfile .shadow-fuzzer/fuzz-payer.json
fi

echo "▸ anchor build"
anchor build

echo "▸ anchor test (proves bugs locally)"
anchor test --skip-deploy || true

echo "▸ shadow-fuzz run (snapshot → private sandbox → fuzz)"
PROGRAM_ID="$(solana address -k target/deploy/vulnerable_vault-keypair.json)"
SANDBOX="${SHADOW_SANDBOX:-magicblock}"
pnpm --filter @shadow-fuzzer/cli exec shadow-fuzz run "$PROGRAM_ID" \
  --sandbox "$SANDBOX" \
  --budget 500 \
  --report-dir ./reports
