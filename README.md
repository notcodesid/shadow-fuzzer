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

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SHADOW FUZZER PIPELINE                            │
│                                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │  Target   │    │  Helius  │    │  Private Sandbox  │    │    Agent     │  │
│  │ Program   │───▶│ Snapshot │───▶│  (MagicBlock ER)  │───▶│    Brain     │  │
│  │ (mainnet) │    │          │    │                    │    │              │  │
│  └──────────┘    └──────────┘    └──────────────────┘    └──────┬───────┘  │
│                                         ▲                       │          │
│                                         │                       ▼          │
│                                   ┌─────┴─────┐          ┌────────────┐   │
│                                   │  Surfpool  │          │  Findings  │   │
│                                   │ (fallback) │          │  + Report  │   │
│                                   └───────────┘          └────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Agent Brain Pipeline

```
┌─────────────┐     ┌─────────────────┐     ┌────────────────┐
│  1. Load IDL │────▶│ 2. Static       │────▶│ 3. Seed State  │
│              │     │    Analyzer      │     │    (mint, vault │
│  Parse the   │     │    (MISSING_     │     │    victim +     │
│  program's   │     │    SIGNER rule)  │     │    deposit)     │
│  interface   │     │                  │     │                 │
└─────────────┘     └─────────────────┘     └───────┬────────┘
                                                     │
                    ┌─────────────────┐     ┌───────▼────────┐
                    │ 5. Emit Finding │◀────│ 4. Construct   │
                    │    + Report     │     │    Adversarial  │
                    │                 │     │    Transaction  │
                    │  Only if tx     │     │                 │
                    │  lands AND      │     │  Sign as        │
                    │  funds moved    │     │  attacker, pass │
                    └─────────────────┘     │  victim as owner│
                                            └────────────────┘
```

### Sandbox Architecture

```
                    ┌─────────────────────────────────────────┐
                    │            FUZZ LOOP                     │
                    │                                         │
  Base Layer RPC    │    Sandbox Connection                    │
  ┌─────────────┐   │    ┌─────────────────────────┐          │
  │ SPL helpers │   │    │  Exploit transactions    │          │
  │ createMint  │   │    │  (routed via Magic       │          │
  │ rent calcs  │   │    │   Router to private ER   │          │
  │ getAccount  │   │    │   validator)             │          │
  └──────┬──────┘   │    └────────────┬────────────┘          │
         │          │                 │                        │
         ▼          │                 ▼                        │
  ┌─────────────┐   │    ┌─────────────────────────┐          │
  │   devnet /  │   │    │  MagicBlock Private ER   │          │
  │   mainnet   │   │    │  ┌───────────────────┐   │          │
  │   RPC       │   │    │  │ Validator          │   │          │
  └─────────────┘   │    │  │ MAS1Dt9q…k57      │   │          │
                    │    │  │                    │   │          │
                    │    │  │ Invisible to       │   │          │
                    │    │  │ public mempool     │   │          │
                    │    │  └───────────────────┘   │          │
                    │    │           OR              │          │
                    │    │  ┌───────────────────┐   │          │
                    │    │  │ Surfpool (local    │   │          │
                    │    │  │ fallback)          │   │          │
                    │    │  └───────────────────┘   │          │
                    │    └─────────────────────────┘          │
                    └─────────────────────────────────────────┘

  Why two connections? Magic Router returns slightly different
  RPC shapes that web3.js strict validators reject. SPL helpers
  hit the base layer; exploit txs go through the sandbox.
```

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
git clone https://github.com/notcodesid/shadow-fuzzer.git
cd shadow-fuzzer
pnpm install
pnpm demo
```

The `demo` command spawns a local validator with the vulnerable program preloaded, then the agent rediscovers the planted bug autonomously (~5 seconds, zero config):

```
shadow-fuzz demo — boots a local validator with a vulnerable vault
preloaded, then lets the agent rediscover the planted bug autonomously.

✔ local validator ready (rpc http://127.0.0.1:8899)
✔ done — 1 finding (1/1 exploit txs landed)

  ✗ MISSING_SIGNER-withdraw-01 [critical] withdraw: position drained without owner signature
```

Or run the full test suite:

```bash
anchor build
anchor test
cat reports/report-*.md
```

## What you're looking at

```
shadow-fuzzer/
├── programs/
│   └── vulnerable-vault/          # Anchor program — deliberately broken
│       └── src/instructions/
│           ├── withdraw.rs        # BUG #2: owner: UncheckedAccount, no has_one
│           ├── deposit.rs         # BUG #1: unchecked + instead of checked_add
│           ├── delegate_vault.rs  # Private ER delegation flow
│           └── undelegate_for_fuzz.rs
├── packages/
│   ├── agent/src/
│   │   ├── brain/
│   │   │   ├── static_analyzer.ts # IDL walker — flags missing-signer shapes
│   │   │   ├── state.ts           # Synthesizes vault scenario in sandbox
│   │   │   ├── exploit.ts         # Concrete missing-signer attacker
│   │   │   └── lifecycle.ts       # Delegate / undelegate orchestration
│   │   ├── sandbox.ts             # MagicBlock primary, Surfpool fallback
│   │   ├── snapshot.ts            # Helius-based state capture
│   │   ├── invariants.ts          # INV-1 / INV-2 / INV-3 checks
│   │   ├── attacker.ts            # Fuzz loop orchestrator
│   │   └── report.ts              # Markdown + JSON output
│   └── cli/src/
│       ├── commands/
│       │   ├── demo.ts            # Zero-config demo runner
│       │   └── run.ts             # Full fuzz against any program
│       └── util/validator.ts      # Local validator spawning
├── tests/
│   ├── vault.spec.ts              # Manual exploit proof (ground truth)
│   └── brain.spec.ts              # Autonomous rediscovery test
├── public/
│   └── index.html                 # Landing page
└── reports/                       # Generated findings (MD + JSON)
```

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
