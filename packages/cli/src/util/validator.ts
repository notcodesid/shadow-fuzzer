import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";

// Spawns `solana-test-validator` with our bundled vulnerable_vault binary
// preloaded at the canonical program ID, then funds a fresh demo keypair
// off it. Returns a teardown function that kills the validator and cleans
// up the temp ledger.
//
// Why this shape: `solana-test-validator --bpf-program <ID> <PATH>` boots
// a clean cluster with the program already deployed, so we don't need an
// `anchor deploy` step at runtime. The validator owns its own ledger
// directory; we sandbox it under a temp dir so concurrent demos don't
// collide and ledger garbage doesn't accumulate.

const VALIDATOR_RPC = "http://127.0.0.1:8899";
const READY_TIMEOUT_MS = 30_000;
const PROGRAM_ID = "CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC";

export interface SpawnedValidator {
  rpcUrl: string;
  payerKeypairPath: string;
  payerPubkey: string;
  teardown: () => Promise<void>;
}

export interface SpawnArgs {
  programSoPath: string;
  airdropSol?: number;
}

export async function spawnLocalValidator(args: SpawnArgs): Promise<SpawnedValidator> {
  const ledgerDir = mkdtempSync(join(tmpdir(), "shadow-fuzz-demo-"));
  const child = spawn(
    "solana-test-validator",
    [
      "--bpf-program",
      PROGRAM_ID,
      args.programSoPath,
      "--ledger",
      ledgerDir,
      "--reset",
      "--quiet",
      "--rpc-port",
      "8899",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: false },
  );

  // Surface any startup error before we hand the user a hung promise.
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    if (line.includes("Address already in use")) {
      throw new Error(
        "port 8899 is already in use — another solana-test-validator is running. " +
          "Kill it with `pkill solana-test-validator` and re-run.",
      );
    }
  });

  await waitForReady(VALIDATOR_RPC, READY_TIMEOUT_MS, child);

  // Mint a fresh demo keypair and airdrop from the validator's faucet.
  const payer = Keypair.generate();
  const payerKeypairPath = join(ledgerDir, "demo-payer.json");
  writeFileSync(payerKeypairPath, JSON.stringify(Array.from(payer.secretKey)));

  const conn = new Connection(VALIDATOR_RPC, "confirmed");
  const sig = await conn.requestAirdrop(
    payer.publicKey,
    (args.airdropSol ?? 100) * LAMPORTS_PER_SOL,
  );
  await conn.confirmTransaction(sig, "confirmed");

  const teardown = async (): Promise<void> => {
    if (!child.killed) {
      child.kill("SIGINT");
      // Give it a moment to flush, then SIGKILL if still around.
      await new Promise((r) => setTimeout(r, 500));
      if (!child.killed) child.kill("SIGKILL");
    }
  };

  // Best-effort cleanup if the host process exits without calling teardown.
  process.on("exit", () => {
    if (!child.killed) child.kill("SIGKILL");
  });

  return {
    rpcUrl: VALIDATOR_RPC,
    payerKeypairPath,
    payerPubkey: payer.publicKey.toBase58(),
    teardown,
  };
}

async function waitForReady(
  rpcUrl: string,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const start = Date.now();
  const conn = new Connection(rpcUrl, "confirmed");

  // Phase 1: wait for the RPC to accept connections.
  let rpcUp = false;
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited (code ${child.exitCode}) before becoming ready`,
      );
    }
    try {
      await conn.getSlot();
      rpcUp = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!rpcUp) {
    throw new Error(
      `solana-test-validator did not become ready within ${timeoutMs}ms — is it installed and on PATH?`,
    );
  }

  // Phase 2: wait for the BPF program to be visible. The validator loads
  // programs from --bpf-program asynchronously; getSlot() succeeds before
  // the program account is queryable.
  const programPk = new PublicKey(PROGRAM_ID);
  while (Date.now() - start < timeoutMs) {
    const info = await conn.getAccountInfo(programPk, "confirmed");
    if (info) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `solana-test-validator started but program ${PROGRAM_ID} not visible after ${timeoutMs}ms`,
  );
}

export function checkSolanaCli(): { ok: boolean; hint?: string } {
  // Cheap PATH check — the actual readiness probe runs after spawn.
  try {
    execSync("which solana-test-validator", { stdio: "ignore" });
    return { ok: true };
  } catch {
    return {
      ok: false,
      hint:
        "solana-test-validator not found on PATH. Install the Solana CLI from https://solana.com/developers/installation, " +
        "then re-run `shadow-fuzz demo`.",
    };
  }
}
