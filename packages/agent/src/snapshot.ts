import { Connection, PublicKey } from "@solana/web3.js";

import { logger } from "./logger.js";
import type { Snapshot, SnapshotAccount } from "./types.js";

// Pull the program executable + every account owned by it from mainnet
// (or whichever RPC the agent points at) so the private sandbox can be
// seeded with a faithful copy of live state.
//
// We deliberately use plain `getProgramAccounts` here. Helius's enhanced
// endpoints (DAS, getAssetsByOwner) are layered on top in `enrich()` for
// programs that emit token/NFT state — without them the fuzzer can still
// run, just with less context for the LLM attacker.
export async function captureSnapshot(
  rpcUrl: string,
  programId: PublicKey,
): Promise<Snapshot> {
  const conn = new Connection(rpcUrl, "confirmed");
  const slot = BigInt(await conn.getSlot("confirmed"));
  logger.info({ programId: programId.toBase58(), slot: slot.toString() }, "snapshot:start");

  const programInfo = await conn.getAccountInfo(programId, "confirmed");
  if (!programInfo) {
    throw new Error(`program ${programId.toBase58()} not found at ${rpcUrl}`);
  }

  const owned = await conn.getProgramAccounts(programId, { commitment: "confirmed" });

  const accounts: SnapshotAccount[] = owned.map((entry) => ({
    pubkey: entry.pubkey,
    owner: entry.account.owner,
    lamports: BigInt(entry.account.lamports),
    data: entry.account.data,
    executable: entry.account.executable,
  }));

  logger.info(
    { programId: programId.toBase58(), accounts: accounts.length },
    "snapshot:done",
  );

  return {
    programId,
    programData: programInfo.data,
    accounts,
    slot,
    capturedAtMs: Date.now(),
  };
}
