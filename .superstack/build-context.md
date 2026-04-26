# Build Context — Shadow Fuzzer

Phase handoff for `/build-with-claude` and downstream skills.

## stack
- **language:** Rust (Anchor 0.31.1 program) + TypeScript (agent + CLI)
- **runtime:** Node 24, pnpm 9 workspace, Cargo workspace
- **on-chain framework:** Anchor 0.31.1 (bumped from 0.30.1 — 0.30's IDL builder calls removed nightly `proc_macro::SourceFile` which doesn't exist in rustc 1.94)
- **agent runtime:** SendAI / Solana Agent Kit (`solana-agent-kit` 1.4.x) — wired as a dependency, brain swap pending
- **sandbox primary:** MagicBlock Private Ephemeral Rollups (`@magicblock-labs/ephemeral-rollups-sdk`)
- **sandbox fallback:** Surfpool (auto-fallback in `provisionWithFallback`)
- **rpc / snapshot:** Helius (`helius-sdk`)
- **mcps wired in `.mcp.json`:** helius, solana (sendai), anchor, solana-fender
- **skills relevant to this build:** programs-anchor, security, testing, surfpool, vulnhunter-skill, solana-agent-kit-skill, helius-build-skill

## architecture
- **pattern:** hybrid Pattern 4 (on-chain program) + Pattern 2 (agent kit) — does not match a single solana-new template, hand-scaffolded.
- **monorepo shape:** `programs/*` (Cargo workspace) + `packages/*` (pnpm workspace), tests at root, optional `app/` reserved for the stretch dashboard.
- **demo target:** `programs/vulnerable-vault` — two planted bugs:
  - BUG #1 unchecked add in `deposit` → u64 wrap
  - BUG #2 missing `has_one` / signer check on `withdraw` → arbitrary drain
- **invariants:** INV-1 / INV-2 / INV-3 in `packages/agent/src/invariants.ts`
- **fuzz loop:** `packages/agent/src/attacker.ts` — rule-based scaffold, brain plug-point marked with `TODO(integration)` for the SendAI driver.
- **cli surface:** `shadow-fuzz run <program-id> [--sandbox magicblock|surfpool] [--budget N] [--parallel N] [--report-dir path]`
- **reports:** markdown + JSON, written to `./reports/` per run.

## program
- **program id:** `CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC`
- **keypair:** `target/deploy/vulnerable_vault-keypair.json` (gitignored except for keypair files in target/deploy)
- **declared in:** `programs/vulnerable-vault/src/lib.rs::declare_id!`
- **anchor toml entries:** localnet + devnet both pinned to the same id

## planted bugs (after build-with-claude phase 1)
- **BUG #2 (runtime-exploitable):** missing signer / `has_one` check in `instructions/withdraw.rs`. Exploit verified end-to-end in `tests/vault.spec.ts` — attacker drains victim's position by passing victim's pubkey as `owner` and signing the tx with the attacker's keypair as fee payer.
- **BUG #1 (static finding):** unchecked `+` in `instructions/deposit.rs::handler`. Bug shape preserved in source (see comment block); not runtime-exploitable through public ix surface because SPL token's own u64 supply invariants block the wrap. The agent's static pass should still flag this as a high-confidence smell — runtime-reachable the moment the program adds yield-accrual or a multi-mint variant.

## build_status
```json
{
  "scaffold_complete": true,
  "deps_installed": true,
  "program_built": true,
  "exploit_suite_passing": true,
  "magicblock_provisioning_wired": true,
  "magicblock_account_delegation_ix": true,
  "magicblock_access_control_ix": false,
  "agent_brain_wired": false,
  "demo_recorded": false,
  "stretch_dashboard": false,
  "stretch_reputation_nft": false
}
```

## next-actions (ordered, for the next session)
1. ✅ ~~Install deps~~ — done (anchor + spl + magicblock + sendai resolved at root + workspace).
2. ✅ ~~Build the program~~ — done on Anchor 0.31.1; IDL at `target/idl/vulnerable_vault.json`, .so at `target/deploy/vulnerable_vault.so`.
3. ✅ ~~Run the local exploit suite~~ — `anchor test` passes; BUG #2 demonstrated end-to-end.
4. ✅ ~~Wire MagicBlock provisioning (connection layer)~~ — `MagicBlockProvider.provision` now opens a Magic Router connection, calls `getClosestValidator()`, and (when `MAGICBLOCK_AUTH_KEYPAIR` is set) acquires a Private-ER auth token via `getAuthToken()`. Validator pubkey is surfaced in the report header. 5 unit tests in `packages/agent/src/sandbox.test.ts` cover env-required, success, unreachable-router, fallback-to-surfpool, and explicit-surfpool paths.
4b. ✅ ~~Add on-chain `delegate_vault` + `undelegate_for_fuzz` ix (public-ER flow)~~ — program now compiles against `ephemeral-rollups-sdk = "0.11.1" features = ["anchor"]` on top of `anchor-lang 0.31.1`. The `#[ephemeral]` macro is on the program module; new ix `delegate_vault` (uses `#[delegate]` + `delegate_pda` CPI, optional `validator: Option<AccountInfo>` to pin) and `undelegate_for_fuzz` (uses `#[commit]` + `MagicIntentBundleBuilder::commit_and_undelegate(...).build_and_invoke()` — `FoldableIntentBuilder` trait must be in scope). IDL emits 7 ix incl. auto-injected `process_undelegation`. BUG #2 exploit suite still passes against the rebuilt program; agent + CLI typecheck.
4c. **Add Private-ER access-control ix** *(prize-tier finishing piece)* — replicate `magicblock-engine-examples/anchor-counter/programs/private-counter`'s pattern: switch the SDK feature set to `["anchor", "access-control"]`, add a `Permission` PDA + Permission Program CPIs (`CreatePermissionCpiBuilder`, `DelegatePermissionCpiBuilder`, `UpdatePermissionCpiBuilder`), and a `CommitAndUndelegatePermissionCpiBuilder` flow in the undelegate ix. Required for the "private" prize tier; gated behind step 5 (we want to see end-to-end fuzz lifecycle on a public ER first to keep the surface narrow).
5. **Wire the SendAI brain** — replace `trySingleAttack` in `packages/agent/src/attacker.ts` with an Agent-Kit driver that picks instructions from the IDL and crafts adversarial argument values. The agent's lifecycle is now: snapshot → `MagicBlockProvider.provision` → call `delegate_vault` (passing the chosen validator pubkey) → fuzz loop with `sendMagicTransaction` → call `undelegate_for_fuzz` → write report. Acceptance: a fresh fuzz run on the vault rediscovers BUG #2 without reading the test file.
6. **Record the demo** — `bash scripts/run-demo.sh`, capture terminal + the generated `reports/report-*.md`.
7. **Stretch:** flesh out `app/` (Next.js dashboard surfacing the latest report) AND Metaplex + SNS "Bugs Squashed" reputation NFT. Both gated behind a green run of step 6.

## guardrails
- **Don't soften the planted bugs** — their shape is the demo's narrative.
- **MagicBlock is the prize-eligible path.** Surfpool is fallback only; never present a Surfpool-only result as the headline demo.
- **No secrets in git.** `.env` and `.shadow-fuzzer/` are gitignored.
- **Stretch goals are gated.** Do not start the dashboard or the NFT badge until the agent's CLI run is green end-to-end.

## event
- **target:** Solana Blitz v4 — virtual hackathon, agentic theme.
- **prize fit:** 1st place ($500 USDC, "best agentic build") + Ephemeral Rollups / Private ERs bonus.
- **luma:** https://luma.com/kfv9avi8

## references
- spec: https://ethereal-alto-f58.notion.site/shodow-fuzzer-33adb9bb546c802db505d519a0f221f3
- idea-context.md: not present (this scaffold was driven directly from the Notion spec)
