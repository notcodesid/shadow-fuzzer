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
//   1. Load the program's IDL.
//   2. Run static analysis to surface candidates worth probing.
//   3. Seed legitimate state on the BASE LAYER (SPL helpers like
//      createMint depend on standard RPC responses that the Magic Router
//      doesn't always serve identically).
//   4. If sandbox is magicblock: delegate the vault PDA into the Private
//      ER. After this, txs touching the vault route via the Magic Router
//      to the chosen ER validator.
//   5. Run exploits via the SANDBOX connection so any private-validator
//      routing actually applies.
//   6. Always undelegate at the end (finally block) so leases don't
//      orphan even on crashes.

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

  // Two connections, two providers, two Programs. The base connection
  // serves SPL helpers that internally hit `getMinimumBalanceForRent
  // Exemption` etc. — those calls don't need ER routing and the Magic
  // Router responds with a slightly different shape that web3.js's
  // strict superstruct validators reject. The sandbox connection is
  // where we want exploit txs to land so the validator-routing actually
  // applies.
  const baseConn = new Connection(config.baseRpcUrl, "confirmed");
  const sandboxConn = new Connection(sandbox.rpcUrl, "confirmed");

  const baseProgram = makeProgram(idl, baseConn, payer);
  const sandboxProgram = makeProgram(idl, sandboxConn, payer);

  const seeded = await seedVaultState({
    programId: config.programId,
    program: baseProgram,
    connection: baseConn,
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

  // Delegate against the BASE layer. The delegation program lives on
  // the base layer; the Magic Router can't process the delegate ix
  // itself because the vault still belongs to our program at this point.
  if (sandbox.kind === "magicblock") {
    await delegateVaultForFuzz({
      programId: config.programId,
      program: baseProgram,
      connection: baseConn,
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
        // Exploits go through the SANDBOX connection so the Magic Router
        // routes them at the validator selected during provision. For
        // surfpool this is the same as base; for magicblock it's the
        // private validator endpoint.
        program: sandboxProgram,
        connection: sandboxConn,
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
      // Undelegate on the base layer so the commit lands and observers
      // at the base layer see the post-fuzz state.
      await undelegateVaultForFuzz({
        programId: config.programId,
        program: baseProgram,
        connection: baseConn,
        payer,
        seeded,
      });
    }
  }

  return { txsAttempted: attempted, txsLanded: landed, findings };
}

function makeProgram(idl: Idl, connection: Connection, payer: Keypair): anchor.Program {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  return new anchor.Program(idl, provider) as unknown as anchor.Program;
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
  const seq = String(currentCount + 1).padStart(2, "0");
  return `${candidate.kind}-${candidate.instructionName}-${seq}`;
}

async function loadIdl(config: FuzzConfig): Promise<Idl> {
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
