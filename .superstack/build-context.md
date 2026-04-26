# Build Context — Shadow Fuzzer

Phase handoff for `/build-with-claude` and downstream skills.

## stack
- **language:** Rust (Anchor 0.30.1 program) + TypeScript (agent + CLI)
- **runtime:** Node 24, pnpm 9 workspace, Cargo workspace
- **on-chain framework:** Anchor 0.30.1
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

## build_status
```json
{
  "scaffold_complete": true,
  "deps_installed": false,
  "program_built": false,
  "exploit_suite_passing": false,
  "agent_brain_wired": false,
  "magicblock_provisioning_wired": false,
  "demo_recorded": false,
  "stretch_dashboard": false,
  "stretch_reputation_nft": false
}
```

## next-actions (ordered, for `/build-with-claude`)
1. **Install deps** — `pnpm install` at repo root. Pulls in workspace + root devDeps for tests.
2. **Build the program** — `anchor build`. Verifies the Cargo workspace and emits the IDL the test suite imports.
3. **Run the local exploit suite** — `anchor test --skip-deploy`. Both `tests/vault.spec.ts` cases must pass, proving the planted bugs work end-to-end.
4. **Wire MagicBlock provisioning** — replace the stub in `packages/agent/src/sandbox.ts::MagicBlockProvider.provision` with the real `@magicblock-labs/ephemeral-rollups-sdk` call. Acceptance: a fuzz run reports `sandbox: magicblock` in the report header without falling back.
5. **Wire the SendAI brain** — replace `trySingleAttack` in `packages/agent/src/attacker.ts` with an Agent-Kit driver that picks instructions from the IDL and crafts adversarial argument values. Acceptance: a fresh fuzz run on the vault rediscovers at least BUG #2 without reading the test file.
6. **Record the demo** — `bash scripts/run-demo.sh`, capture terminal + the generated `reports/report-*.md`.
7. **Stretch:** flesh out `app/` (Next.js dashboard surfacing the latest report) AND `Metaplex + SNS` "Bugs Squashed" reputation NFT. Both gated behind a green run of step 6.

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
