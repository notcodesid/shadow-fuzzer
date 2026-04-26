import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

// Sets up a legitimate vault scenario inside the sandbox so the exploit
// runner has something realistic to attack. This is the cheap path: we
// instantiate fresh state from scratch, without snapshotting a real
// mainnet vault. Snapshotting (Helius-driven) becomes meaningful when
// targeting a deployed program with non-trivial state we want to preserve;
// for the demo the synthetic scenario is more reproducible and faster.

const VAULT_SEED = Buffer.from("vault");
const VAULT_AUTHORITY_SEED = Buffer.from("vault-authority");
const POSITION_SEED = Buffer.from("position");

export interface SeededVault {
  mint: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  vaultTokenAccount: PublicKey;
  victim: Keypair;
  victimTokenAccount: PublicKey;
  victimPosition: PublicKey;
  initialDepositAmount: bigint;
}

export interface SeedArgs {
  programId: PublicKey;
  program: anchor.Program;
  connection: Connection;
  payer: Keypair;
  initialDepositAmount?: bigint;
}

export async function seedVaultState(args: SeedArgs): Promise<SeededVault> {
  const { programId, program, connection, payer } = args;
  const initialDepositAmount = args.initialDepositAmount ?? 1_000_000n;

  const mint = await createMint(connection, payer, payer.publicKey, null, 6);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, mint.toBuffer()],
    programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [VAULT_AUTHORITY_SEED, vault.toBuffer()],
    programId,
  );

  const vaultTokenAccountKp = Keypair.generate();
  // The `Program` is constructed from a runtime-loaded IDL so its
  // `.methods` are typed as `Record<string, MethodsFn | undefined>`.
  // We've validated the IDL shape upstream (analyzeIdl), so the
  // non-null assertions are safe and shorter than a typed-IDL refactor.
  // `Program` is built from a runtime-loaded IDL, so anchor types `methods`
  // as `Record<string, MethodsFn | undefined>`. We've validated the IDL
  // shape upstream (analyzeIdl), so a one-line cast is the right tradeoff
  // versus retyping the full IDL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as Record<string, (...a: any[]) => any>;
  const initSig = await methods
    .initializeVault!()
    .accounts({
      authority: payer.publicKey,
      mint,
      vault,
      vaultAuthority,
      vaultTokenAccount: vaultTokenAccountKp.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([vaultTokenAccountKp])
    .rpc();
  await connection.confirmTransaction(initSig, "confirmed");

  const victim = Keypair.generate();
  await fundLamports(connection, payer, victim.publicKey, LAMPORTS_PER_SOL);

  const victimTokenAccount = await createAssociatedTokenAccount(
    connection,
    payer,
    mint,
    victim.publicKey,
  );

  await mintTo(
    connection,
    payer,
    mint,
    victimTokenAccount,
    payer,
    initialDepositAmount,
  );

  const [victimPosition] = PublicKey.findProgramAddressSync(
    [POSITION_SEED, vault.toBuffer(), victim.publicKey.toBuffer()],
    programId,
  );

  const openSig = await methods
    .openPosition!()
    .accounts({
      owner: victim.publicKey,
      vault,
      position: victimPosition,
      systemProgram: SystemProgram.programId,
    })
    .signers([victim])
    .rpc();
  await connection.confirmTransaction(openSig, "confirmed");

  const depositSig = await methods
    .deposit!(new BN(initialDepositAmount.toString()))
    .accounts({
      owner: victim.publicKey,
      vault,
      position: victimPosition,
      vaultTokenAccount: vaultTokenAccountKp.publicKey,
      userTokenAccount: victimTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([victim])
    .rpc();
  await connection.confirmTransaction(depositSig, "confirmed");

  return {
    mint,
    vault,
    vaultAuthority,
    vaultTokenAccount: vaultTokenAccountKp.publicKey,
    victim,
    victimTokenAccount,
    victimPosition,
    initialDepositAmount,
  };
}

async function fundLamports(
  connection: Connection,
  funder: Keypair,
  to: PublicKey,
  lamports: number,
): Promise<void> {
  // Some sandboxes don't allow `requestAirdrop` (Magic Router, devnet
  // rate limits). When that path fails we fall back to a plain SystemProgram
  // transfer from the agent's payer — which always works because the agent
  // pre-funds the payer before invoking us.
  try {
    const sig = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  } catch {
    // fall through
  }
  const tx = new (await import("@solana/web3.js")).Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: to,
      lamports,
    }),
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = funder.publicKey;
  const sig = await connection.sendTransaction(tx, [funder]);
  await connection.confirmTransaction(sig, "confirmed");
}
