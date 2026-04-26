# Shadow Fuzzer

A private sandbox where an AI security agent fuzzes Solana programs without leaking exploits to MEV bots. Submission target: **Solana Blitz v4** (agentic + Ephemeral Rollups prize categories).

## Core flow
```
mainnet program  →  Helius snapshot  →  MagicBlock Private ER  →  agent fuzz loop  →  invariant violation  →  signed report
```
Nothing the agent does ever touches the public mempool.

## Repo layout
- `programs/vulnerable-vault/` — Anchor program. **Deliberately broken.** Two planted bugs the agent must rediscover:
  - **BUG #2 (runtime-exploitable, headline):** `instructions/withdraw.rs` has no `has_one = owner` and no manual signer check. Anyone can drain any position. Proven end-to-end in `tests/vault.spec.ts`.
  - **BUG #1 (static finding):** `instructions/deposit.rs` uses raw `+` instead of `checked_add`. SPL token's own u64 supply invariants block this from wrapping through the public ix surface, so we don't have a runtime test for it — the agent's static pass should still flag it as a high-confidence smell. Bug shape preserved in source.
  - DO NOT FIX EITHER BUG. They are the demo target.
- `packages/agent/` — the fuzz brain (TS):
  - `snapshot.ts` Helius-based state capture
  - `sandbox.ts` MagicBlock primary, Surfpool fallback (`provisionWithFallback`)
  - `attacker.ts` fuzz loop — currently rule-based, swaps to SendAI / Solana Agent Kit driver in the next phase
  - `invariants.ts` INV-1 / INV-2 / INV-3 (see comment block in file)
  - `report.ts` markdown + JSON output
- `packages/cli/` — the `shadow-fuzz` binary
- `tests/vault.spec.ts` — local exploit suite. Both planted bugs are proven from a known-keys vantage point so we have ground truth for the agent's discovery target.
- `scripts/run-demo.sh` — end-to-end demo runner

## Sandbox policy
**MagicBlock Private ER is the primary execution path.** Surfpool is wired as automatic fallback so the demo doesn't block on partner provisioning, but every prize-eligible flow MUST land on MagicBlock when credentials are available. The CLI surfaces the actual sandbox used in the report header.

## Invariants (live in `packages/agent/src/invariants.ts`)
- **INV-1** `vault.total_deposits == Σ user_position.balance`
- **INV-2** `spl_balance(vault_token_account) == vault.total_deposits`
- **INV-3** any successful withdraw must be signed by `position.owner`

## Toolchain
- Anchor 0.31.1 (cli + lang + spl + ts), Solana CLI 3.1.12, Rust 1.94, Node 24, pnpm 9
- Program ID: `CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC`
- Anchor 0.30.x is a no-go on rustc 1.94+ — its IDL builder calls the removed nightly `proc_macro::SourceFile` API. Don't downgrade.

## Build / test / fuzz
```bash
pnpm install
anchor build
anchor test --skip-deploy        # local exploit suite
pnpm fuzz run <program-id>       # full agent run against a private sandbox
bash scripts/run-demo.sh         # everything end-to-end
```

## Out of scope for the Blitz weekend
- The Next.js dashboard. Stub directory is reserved at `app/` but do not flesh it out until the agent + CLI loop is green.
- The Metaplex + SNS reputation NFT ("Bugs Squashed" badge). Stretch goal — only after the core demo flow is recorded.

## When working on this repo
- Don't refactor the planted bugs into something subtler "for realism" — the bug shapes are intentional and the agent's discovery narrative depends on them.
- The fuzz loop budget defaults to 2000 txs and 8-way parallelism. If the demo run is slow, lower the budget before changing the architecture.
- All secrets go in `.env` (never committed). The agent reads them via `dotenv/config`.
- **solana-test-validator commitment race:** `.rpc()` returns when a tx lands but follow-up reads can briefly observe pre-write state at "confirmed" level. The exploit suite uses an `rpcAndConfirm` helper that explicitly awaits `connection.confirmTransaction(sig, "confirmed")`. Mirror this pattern in any new local-validator tests.
