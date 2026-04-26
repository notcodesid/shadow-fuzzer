import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";

// Bootstrap an Anchor provider from the env that `anchor test` injects.
// Falls back to a localnet + a freshly funded keypair when run standalone
// (useful when the suite is invoked outside of `anchor test`).
export function getProvider(): anchor.AnchorProvider {
  if (anchor.getProvider() instanceof anchor.AnchorProvider) {
    return anchor.getProvider() as anchor.AnchorProvider;
  }

  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ?? `${process.env.HOME ?? ""}/.config/solana/id.json`;
  const secret = JSON.parse(readFileSync(walletPath, "utf8")) as number[];
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
  const connection = new anchor.web3.Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
}
