# Shadow Fuzzer

A private sandbox where an AI security agent fuzzes Solana programs without leaking exploits to MEV bots.

Built for [Solana Blitz v4](https://luma.com/kfv9avi8) — agentic + Ephemeral Rollups categories.

---

## The problem

You can't safely test a real bug on Solana mainnet. Smart contracts are live and public; to confirm a vulnerability is real, you often need to test it under mainnet-like conditions. But the moment you submit a candidate exploit transaction:

- It's visible in the public mempool
- MEV bots scan it before it executes
- If it looks profitable, they copy and front-run it
- The funds are gone before you've even confirmed the bug

So researchers either test on stale local forks (and miss real conditions), or lose the bounty to a bot.

## The insight

A **Private Ephemeral Rollup** is a private, high-speed validator the public network can't observe. Move the program's state into one for the duration of a fuzz session, run thousands of adversarial transactions inside, and only commit the final state back to the base layer once the developer has been warned.

## What this repo does

```
mainnet program  →  snapshot  →  Private ER sandbox  →  AI agent fuzzes  →  signed report
```

The agent autonomously:

1. **Reads the program's IDL** — no test files, no hints
2. **Identifies suspicious instruction shapes** via static analysis (e.g. accounts named `owner` that are neither signers nor `has_one`-verified, but are referenced by sibling PDA seeds)
3. **Sets up a legitimate scenario** in the sandbox (mint, vault, victim with a deposit)
4. **Constructs an adversarial transaction** that confirms or refutes the candidate
5. **Emits a structured finding** with on-chain evidence + a fix recommendation

## Try it in 90 seconds

Prereqs: Node 20+, pnpm, Rust, Solana CLI, Anchor (via [avm](https://www.anchor-lang.com/docs/installation)).

```bash
git clone <this-repo> shadow-fuzzer
cd shadow-fuzzer
pnpm install
anchor build
anchor test
```

If you see `Tests 2 passed (2)`, the MVP works on your machine. The agent autonomously rediscovered the planted bug and wrote a report:

```bash
cat reports/report-*.md
```

You should see something like:

```
# Shadow Fuzzer report
- target:    CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC
- sandbox:   surfpool
- findings:  1

## MISSING_SIGNER-withdraw-01 — withdraw: position drained without owner signature
- invariant:    INV-3
- severity:     critical
- evidence tx:  2ycWV5ARip6jiwcg8EC34EEi9Wjz2PrdCtHwdtnqN7S5mctQrE35gF7H6Ety5siM43h3o8WZzQy2NcNyJ8mf648a

Instruction `withdraw` reads `owner` as the privileged role for at least one
PDA-derived account, but `owner` is neither marked as a signer nor verified
through a `has_one` / `relations` constraint. Any caller can pass an arbitrary
pubkey here and the runtime will accept it...

**Confirmed exploit.** The agent constructed a `withdraw` transaction passing
[victim] as `owner` and signed/paid for the tx with an attacker keypair. The
transaction landed and transferred 1,000,000 base units to the attacker.

**Fix.** Add either `#[account(has_one = owner)]` on the `position` account,
or change `owner: UncheckedAccount<'info>` to `owner: Signer<'info>`.
```

End-to-end runtime: ~5 seconds.

## What you're looking at

- **`programs/vulnerable-vault/`** — an Anchor 0.31.1 program with a deliberately planted bug. Realistic shape, not a toy. **Do not deploy to mainnet.**
  - `instructions/withdraw.rs` — the bug: `owner: UncheckedAccount<'info>`, no `has_one`. Anyone can drain any position.
  - `instructions/delegate_vault.rs` + `undelegate_for_fuzz.rs` — Private-ER access-control flow (CPIs into MagicBlock's Permission Program).
- **`packages/agent/src/brain/`** — the autonomous discovery loop:
  - `static_analyzer.ts` — IDL walker that flags missing-signer / has_one shapes
  - `state.ts` — synthesizes a legitimate vault scenario in the sandbox
  - `exploit.ts` — concrete missing-signer attacker
  - `lifecycle.ts` — delegate / undelegate orchestration
- **`packages/agent/src/sandbox.ts`** — MagicBlock router primary, surfpool fallback
- **`packages/cli/`** — `shadow-fuzz` binary
- **`tests/`** — `vault.spec.ts` (manual ground truth) + `brain.spec.ts` (autonomous discovery)

## Stack

| Layer | Pick |
|---|---|
| On-chain framework | Anchor 0.31.1 |
| Private execution | MagicBlock Ephemeral Rollups (`ephemeral-rollups-sdk` 0.11.x) |
| State snapshot | Helius |
| Agent brain | TypeScript + Solana Agent Kit (SendAI) |
| Identity (planned) | Metaplex + SNS |

## What's done vs. what's next

| | Today | Vision |
|---|---|---|
| **Targets** | Vault-shaped Anchor programs | Any Solana program |
| **Bug classes** | Missing signer / `has_one` | Whole catalog (overflow, oracle manip, CPI abuse, account confusion, …) |
| **Exploit synthesis** | Hardcoded for `withdraw` shape | LLM-driven, IDL-walking |
| **Sandbox** | Surfpool end-to-end ✓. MagicBlock provisions cleanly + selects validator ✓; full delegate→exploit→undelegate router lifecycle has gaps | MagicBlock end-to-end |
| **Narrative** | Templates with on-chain evidence | LLM-generated, business-impact-aware |
| **Identity / reputation** | Not started | NFT badge per confirmed bug (Metaplex + SNS) |

## MagicBlock devnet status

Program deployed at [`CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC`](https://explorer.solana.com/address/CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC?cluster=devnet) on devnet (slot 458238441, 521 KB).

`MagicBlockProvider.provision` against `https://devnet.magicblock.app` succeeds and selects validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`. The on-chain `delegate_vault` and `undelegate_for_fuzz` instructions exist and compile clean against the SDK. Two integration gaps remain on the Magic Router lifecycle (documented in [`.superstack/build-context.md`](.superstack/build-context.md)) — not fundamental flaws, just ER orchestration semantics that need more iteration with the MagicBlock team.

## Architecture decisions worth calling out

- **Two-connection design.** SPL helpers (`createMint`, `getMinimumBalanceForRentExemption`) hit the base-layer RPC; ER-routed ops hit the Magic Router. Magic Router returns slightly-different RPC shapes that web3.js's strict validators reject, and it isn't supposed to serve those calls anyway. Splitting the connections is the right factoring, not a workaround.
- **Static analyzer is high-precision, not high-recall.** The MISSING_SIGNER rule fires only when the suspicious account is referenced by a sibling PDA's seeds — without that tightening it would over-fire on every global-config-admin pubkey. We'd rather miss a bug class than report a false positive.
- **Exploit confirmation, not just suspicion.** A finding only emits if the adversarial tx actually lands AND post-state shows funds moved. Refuted candidates get logged, not reported.

## Built with

- [solana.new](https://www.solana.new) (SendAI + Superteam) — agentic toolkit and skills
- [MagicBlock](https://magicblock.gg) — Ephemeral Rollups
- [Helius](https://helius.dev) — RPC + state snapshot
- [Anchor](https://www.anchor-lang.com) — on-chain framework
- [Metaplex](https://www.metaplex.com) — agent identity (planned)
