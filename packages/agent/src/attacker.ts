import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";

import {
  analyzeIdl,
  delegateVaultForFuzz,
  runExploit,
  seedVaultState,
  undelegateVaultForFuzz,
  type Candidate,
} from "./brain/index.js";
import { logger } from "./logger.js";
import type { Finding, FuzzConfig, Sandbox } from "./types.js";

// The fuzz loop's lifecycle:
//   1. Load the program's IDL (local file by default; on-chain fetch is
//      a future enhancement when we don't have repo access).
//   2. Run static analysis to surface candidates worth probing.
//   3. For each candidate: seed legitimate state, run the concrete
//      exploit constructor, capture any confirmed Finding.
//   4. Return tx counters and findings to the orchestrator.
//
// We bias hard toward a small number of high-precision attempts rather
// than a wide sweep — the demo wants signal, not coverage. When the
// brain grows an LLM-driven attack synthesizer, it'll plug in here as
// an additional source of candidates without changing this loop's shape.

export interface FuzzLoopArgs {
  config: FuzzConfig;
  sandbox: Sandbox;
  payer: Keypair;
}

export interface FuzzLoopResult {
  txsAttempted: number;
  txsLanded: number;
  findings: Finding[];
}

export async function runFuzzLoop(args: FuzzLoopArgs): Promise<FuzzLoopResult> {
  const { config, sandbox, payer } = args;

  const idl = await loadIdl(config);
  const candidates = analyzeIdl(idl);
  logger.info(
    { count: candidates.length, ix: candidates.map((c) => c.instructionName) },
    "brain:static-analysis",
  );

  if (candidates.length === 0) {
    logger.warn("brain:no-candidates — static analyzer found nothing to probe");
    return { txsAttempted: 0, txsLanded: 0, findings: [] };
  }

  const connection = new Connection(sandbox.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider) as unknown as anchor.Program;

  // Single seeded scenario shared across all candidates today. As the
  // brain grows it may want a fresh seed per candidate so independent
  // exploits can't poison each other's state — wire that here when the
  // need shows up.
  const seeded = await seedVaultState({
    programId: config.programId,
    program,
    connection,
    payer,
  });
  logger.info(
    {
      vault: seeded.vault.toBase58(),
      victim: seeded.victim.publicKey.toBase58(),
      depositedBaseUnits: seeded.initialDepositAmount.toString(),
    },
    "brain:state-seeded",
  );

  // For the magicblock path: move the vault state into the Private ER
  // before running exploits. Surfpool stays at base-layer (it IS the
  // base layer). A failed delegate doesn't crash the run — we still
  // get a base-layer-tagged report — but it does mean the demo isn't
  // prize-eligible, so the operator should re-run when the router is
  // healthy.
  if (sandbox.kind === "magicblock") {
    await delegateVaultForFuzz({
      programId: config.programId,
      program,
      connection,
      payer,
      seeded,
      validator: sandbox.validator,
    });
  }

  let attempted = 0;
  let landed = 0;
  const findings: Finding[] = [];

  try {
    for (const candidate of capCandidates(candidates, config.budgetTx)) {
      attempted++;
      const finding = await runExploit({
        candidate,
        programId: config.programId,
        program,
        connection,
        payer,
        seeded,
        findingId: nextFindingId(candidate, findings.length),
      });
      if (finding) {
        landed++;
        findings.push(finding);
        logger.info(
          { id: finding.id, title: finding.title, txs: finding.evidenceTxs },
          "brain:finding-confirmed",
        );
      }
    }
  } finally {
    if (sandbox.kind === "magicblock") {
      await undelegateVaultForFuzz({
        programId: config.programId,
        program,
        connection,
        payer,
        seeded,
      });
    }
  }

  return { txsAttempted: attempted, txsLanded: landed, findings };
}

function capCandidates(candidates: Candidate[], budgetTx: number): Candidate[] {
  // Every confirmed candidate costs roughly 5 txs (seed + exploit + post
  // checks). The budget is in tx-units; cap candidates so we stay roughly
  // within it. The bound here is loose on purpose — the brain's job is
  // to be selective in `analyzeIdl`, not to lean on this clamp.
  const TX_COST_PER_CANDIDATE = 5;
  const max = Math.max(1, Math.floor(budgetTx / TX_COST_PER_CANDIDATE));
  if (candidates.length <= max) return candidates;
  logger.warn(
    { received: candidates.length, capped: max, budgetTx },
    "brain:budget-capped",
  );
  return candidates.slice(0, max);
}

function nextFindingId(candidate: Candidate, currentCount: number): string {
  // Stable, sortable, human-readable id. Doesn't try to be unique
  // across runs — each report is its own scope.
  const seq = String(currentCount + 1).padStart(2, "0");
  return `${candidate.kind}-${candidate.instructionName}-${seq}`;
}

async function loadIdl(config: FuzzConfig): Promise<Idl> {
  // Default convention: target/idl/<program>.json relative to the
  // process cwd. The CLI's working directory is the repo root, so this
  // lands on the freshly-built artifact. Override-by-env hook is left
  // for when we add on-chain `fetchIdl` fallback.
  const path = process.env.SHADOW_IDL_PATH ?? defaultIdlPath();
  const raw = await readFile(path, "utf8");
  const idl = JSON.parse(raw) as Idl;
  if (idl.address && idl.address !== config.programId.toBase58()) {
    logger.warn(
      { idlAddress: idl.address, configProgramId: config.programId.toBase58() },
      "brain:idl-program-id-mismatch",
    );
  }
  return idl;
}

function defaultIdlPath(): string {
  return join(process.cwd(), "target", "idl", "vulnerable_vault.json");
}
