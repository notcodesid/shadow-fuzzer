import { Connection, PublicKey } from "@solana/web3.js";

import type { InvariantViolation } from "./types.js";

// Vault-specific invariants. When we generalize to arbitrary programs the
// agent will derive these from the program IDL + LLM analysis; for the
// hackathon demo target they're hand-written and load-bearing.
//
//   INV-1  vault.total_deposits == Σ user_position.balance
//   INV-2  spl_balance(vault_token_account) == vault.total_deposits
//   INV-3  any successful withdraw must be signed by user_position.owner
//
// INV-1 and INV-2 are state invariants checked after every landed tx.
// INV-3 is a transaction-shape invariant verified by replaying the tx
// metadata and checking the signer set.

// Pulled from target/idl/vulnerable_vault.json. If the program account
// shape changes the IDL discriminators rotate too — re-read the IDL after
// any state.rs edit.
const VAULT_DISCRIMINATOR_HEX = "d308e82b02987577"; // [211,8,232,43,2,152,117,119]
const POSITION_DISCRIMINATOR_HEX = "fbf8d1f553ea111b"; // [251,248,209,245,83,234,17,27]

export interface VaultState {
  pubkey: PublicKey;
  totalDeposits: bigint;
  vaultTokenAccount: PublicKey;
}

export interface PositionState {
  pubkey: PublicKey;
  owner: PublicKey;
  vault: PublicKey;
  balance: bigint;
}

export async function checkStateInvariants(
  rpcUrl: string,
  programId: PublicKey,
): Promise<InvariantViolation[]> {
  const conn = new Connection(rpcUrl, "confirmed");
  const accounts = await conn.getProgramAccounts(programId, { commitment: "confirmed" });

  const vaults = new Map<string, VaultState>();
  const positions: PositionState[] = [];

  for (const { pubkey, account } of accounts) {
    const disc = account.data.subarray(0, 8).toString("hex");
    if (disc === VAULT_DISCRIMINATOR_HEX) {
      vaults.set(pubkey.toBase58(), parseVault(pubkey, account.data));
    } else if (disc === POSITION_DISCRIMINATOR_HEX) {
      positions.push(parsePosition(pubkey, account.data));
    }
  }

  const violations: InvariantViolation[] = [];

  // INV-1
  for (const vault of vaults.values()) {
    const expected = positions
      .filter((p) => p.vault.equals(vault.pubkey))
      .reduce((sum, p) => sum + p.balance, 0n);
    if (expected !== vault.totalDeposits) {
      violations.push({
        invariant: "INV-1",
        message: `vault.total_deposits (${vault.totalDeposits}) != Σ position.balance (${expected})`,
        observed: vault.totalDeposits.toString(),
        expected: expected.toString(),
      });
    }
  }

  // INV-2
  for (const vault of vaults.values()) {
    const tokenAcct = await conn.getTokenAccountBalance(vault.vaultTokenAccount, "confirmed");
    const observed = BigInt(tokenAcct.value.amount);
    if (observed !== vault.totalDeposits) {
      violations.push({
        invariant: "INV-2",
        message: `spl(vault_token_account)=${observed} != vault.total_deposits=${vault.totalDeposits}`,
        observed: observed.toString(),
        expected: vault.totalDeposits.toString(),
      });
    }
  }

  return violations;
}

// INV-3 lives in the tx replay path because it's a property of the tx, not
// the post-state. See packages/agent/src/attacker.ts.
export function verifySignerInvariant(
  positionOwner: PublicKey,
  txSigners: PublicKey[],
): InvariantViolation | null {
  const ok = txSigners.some((s) => s.equals(positionOwner));
  if (ok) return null;
  return {
    invariant: "INV-3",
    message: `withdraw landed without signature from position.owner (${positionOwner.toBase58()})`,
    observed: txSigners.map((s) => s.toBase58()),
    expected: positionOwner.toBase58(),
  };
}

function parseVault(pubkey: PublicKey, data: Buffer): VaultState {
  // 8 disc | 32 authority | 32 mint | 32 vault_token_account | 8 total_deposits | 1 bump | 1 vault_authority_bump
  const vaultTokenAccount = new PublicKey(data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32));
  const totalDeposits = data.readBigUInt64LE(8 + 32 + 32 + 32);
  return { pubkey, totalDeposits, vaultTokenAccount };
}

function parsePosition(pubkey: PublicKey, data: Buffer): PositionState {
  // 8 disc | 32 owner | 32 vault | 8 balance | 1 bump
  const owner = new PublicKey(data.subarray(8, 40));
  const vault = new PublicKey(data.subarray(40, 72));
  const balance = data.readBigUInt64LE(72);
  return { pubkey, owner, vault, balance };
}
