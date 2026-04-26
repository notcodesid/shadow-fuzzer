import { readFile } from "node:fs/promises";

import { Keypair, PublicKey } from "@solana/web3.js";

import { runFuzzLoop } from "./attacker.js";
import { logger } from "./logger.js";
import { provisionWithFallback } from "./sandbox.js";
import { captureSnapshot } from "./snapshot.js";
import { writeReport } from "./report.js";
import type { FuzzConfig, FuzzReport } from "./types.js";

export type { FuzzConfig, FuzzReport, Finding, SandboxKind } from "./types.js";

export interface RunFuzzInput {
  programId: string;
  rpcUrl: string;
  sandbox: "magicblock" | "surfpool";
  budgetTx: number;
  parallelism: number;
  reportDir: string;
  payerKeypairPath: string;
}

// Public entrypoint used by the CLI and (eventually) the dashboard.
// vulnerable program → snapshot → private sandbox → fuzz loop → report.
export async function runFuzz(input: RunFuzzInput): Promise<FuzzReport> {
  const config: FuzzConfig = {
    programId: new PublicKey(input.programId),
    sandbox: input.sandbox,
    budgetTx: input.budgetTx,
    parallelism: input.parallelism,
    reportDir: input.reportDir,
    payerKeypairPath: input.payerKeypairPath,
  };
  const startedAtMs = Date.now();

  const snapshot = await captureSnapshot(input.rpcUrl, config.programId);

  const sandbox = await provisionWithFallback(config.sandbox, { snapshot });
  logger.info({ sandbox: sandbox.kind, rpc: sandbox.rpcUrl }, "sandbox:ready");

  const payer = await loadKeypair(config.payerKeypairPath);

  try {
    const { txsAttempted, txsLanded, findings } = await runFuzzLoop({
      config,
      sandbox,
      payer,
    });

    const report: FuzzReport = {
      config: {
        programId: config.programId,
        sandbox: sandbox.kind,
        budgetTx: config.budgetTx,
        parallelism: config.parallelism,
        reportDir: config.reportDir,
      },
      ...(sandbox.validator ? { validator: sandbox.validator.toBase58() } : {}),
      snapshotSlot: snapshot.slot,
      startedAtMs,
      endedAtMs: Date.now(),
      txsAttempted,
      txsLanded,
      findings,
    };

    await writeReport(config.reportDir, report);
    return report;
  } finally {
    await sandbox.teardown().catch((err) => {
      logger.error({ err: (err as Error).message }, "sandbox:teardown-failed");
    });
  }
}

async function loadKeypair(path: string): Promise<Keypair> {
  const raw = await readFile(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}
