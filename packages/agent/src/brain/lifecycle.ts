import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { logger } from "../logger.js";
import type { SeededVault } from "./state.js";

// Bracket the fuzz loop with on-chain delegate / undelegate calls so the
// vault state spends the run inside a Private MagicBlock ER. The
// connection-layer Sandbox already routes txs to the closest validator;
// these calls are what move the *state itself* across the boundary.
//
// We deliberately swallow errors here rather than crashing the run — a
// router that rejects delegation is annoying but the static-analysis +
// exploit-runner pipeline still produces a valid, if base-layer-tagged,
// report. The demo recording step looks at the report header to decide
// whether the run was prize-eligible (`sandbox: magicblock`) — the
// caller can layer on stricter behaviour by checking the return value.

// Constants pulled from `ephemeral-rollups-sdk` 0.11.x:
//   - PERMISSION_PROGRAM_ID: pinned validator-side gating program
//   - PERMISSION_SEED: PDA prefix used by the permission gating record
const PERMISSION_PROGRAM_ID = new PublicKey("permVRm2EgQrPRRanrjLG5GMA4LdQGM23zenUvSiavq");
const PERMISSION_SEED = Buffer.from("permission:");

// Member flags from the SDK; AUTHORITY = 1 << 0.
const AUTHORITY_FLAG = 0x01;

export interface DelegateForFuzzArgs {
  programId: PublicKey;
  program: anchor.Program;
  connection: Connection;
  payer: Keypair;
  seeded: SeededVault;
  validator?: PublicKey | undefined;
}

export interface DelegateForFuzzResult {
  ok: boolean;
  txSig?: string;
  error?: string;
}

export async function delegateVaultForFuzz(args: DelegateForFuzzArgs): Promise<DelegateForFuzzResult> {
  const { program, connection, payer, seeded, validator } = args;

  // Authority-only member: the agent's payer is allowed to mutate
  // the vault inside the rollup. Without this any random caller with
  // the validator URL could co-opt the fuzz session.
  const members = [{ flags: AUTHORITY_FLAG, pubkey: payer.publicKey }];

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const methods = program.methods as Record<string, (...a: any[]) => any>;
    const sig = await methods
      .delegateVault!(members)
      .accounts({
        payer: payer.publicKey,
        vault: seeded.vault,
        mint: seeded.mint,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        validator: validator ?? null,
      })
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    logger.info({ sig, validator: validator?.toBase58() }, "magicblock:delegate-vault");
    return { ok: true, txSig: sig };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, "magicblock:delegate-vault-failed");
    return { ok: false, error: message };
  }
}

export interface UndelegateForFuzzArgs {
  programId: PublicKey;
  program: anchor.Program;
  connection: Connection;
  payer: Keypair;
  seeded: SeededVault;
}

export async function undelegateVaultForFuzz(args: UndelegateForFuzzArgs): Promise<DelegateForFuzzResult> {
  const { program, connection, payer, seeded } = args;

  const [permission] = PublicKey.findProgramAddressSync(
    [PERMISSION_SEED, seeded.vault.toBuffer()],
    PERMISSION_PROGRAM_ID,
  );

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const methods = program.methods as Record<string, (...a: any[]) => any>;
    const sig = await methods
      .undelegateForFuzz!()
      .accounts({
        payer: payer.publicKey,
        vault: seeded.vault,
        mint: seeded.mint,
        permission,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    logger.info({ sig }, "magicblock:undelegate-for-fuzz");
    return { ok: true, txSig: sig };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, "magicblock:undelegate-for-fuzz-failed");
    return { ok: false, error: message };
  }
}
