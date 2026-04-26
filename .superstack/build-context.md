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
  "magicblock_access_control_ix": true,
  "agent_brain_wired": true,
  "agent_e2e_acceptance_passing": true,
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
4c. ✅ ~~Add Private-ER access-control ix~~ — SDK feature set is now `["anchor", "access-control"]`. `delegate_vault` ix grew a `members: Option<Vec<Member>>` arg and the 9-account shape required by the access-control flow (vault, mint, permission, buffer_permission, delegation_record_permission, delegation_metadata_permission, permission_program, system_program, optional validator). Handler runs three idempotent steps: Create-or-Update Permission → register Permission's own delegation → delegate the vault. `undelegate_for_fuzz` releases the permission via `CommitAndUndelegatePermissionCpiBuilder` *before* committing+undelegating the vault. Both the vault exploit suite AND the brain e2e acceptance test still pass against the rebuilt binary. Binary grew 451kb → 521kb. SDK paths the example references that we double-checked exist in 0.11.2: `ephemeral_rollups_sdk::access_control::instructions::*`, `ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED}`, `ephemeral_rollups_sdk::pda::{DELEGATE_BUFFER_TAG, DELEGATION_RECORD_TAG, DELEGATION_METADATA_TAG}` (re-exported from `dlp_api::pda`), `ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID`.
5. ✅ ~~Wire the agent brain~~ — `packages/agent/src/brain/` ships three modules: `static_analyzer.ts` (IDL walker that flags missing-signer / has_one shapes), `state.ts` (synthesizes a legitimate vault scenario), and `exploit.ts` (concrete missing-signer attacker). `attacker.ts::runFuzzLoop` now does: load IDL → analyze → seed → run exploit per candidate → emit Finding. End-to-end acceptance test in `tests/brain.spec.ts` passes against the local validator: agent rediscovers BUG #2 from the IDL alone (no test-file peek), in 5.2s, generating an INV-3 critical finding with on-chain evidence tx. Static-analyzer unit tests cover positive (withdraw flagged), two negatives (deposit + initialize_vault not flagged), and a tightening test (no PDA-seed reference → no candidate). Choices we deliberately *did not* make: full IDL-driven generic exploit synthesis (the missing-signer attacker is hardcoded for the withdraw shape) and LLM narrative generation (templates for now; SendAI / Anthropic SDK can layer on later).
5b. **(optional) Generic exploit synthesis** — extend `exploit.ts` so the missing-signer handler builds the attack tx purely from the IDL's account list rather than hardcoding the withdraw shape. Lets the agent find the same bug class on programs we haven't seen before. Not required for the Blitz demo but is the natural next iteration.
5c. **(optional) LLM narrative** — gate by `ANTHROPIC_API_KEY` (or fall through to SendAI / OpenAI), generate the human-readable explanation in each Finding's `narrative` field. Templates work fine for the demo.
6. **Record the demo** — `bash scripts/run-demo.sh`, capture terminal + the generated `reports/report-*.md`. The script chains: anchor build → anchor test (proves bugs locally) → shadow-fuzz CLI run (autonomous discovery via brain). Verify that a `sandbox: magicblock` run lands at least one finding before recording.
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
