import { readFile } from "node:fs/promises";

import { getClosestValidator } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk/privacy";
import { Connection, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

import { logger } from "./logger.js";
import type { Sandbox, SandboxKind, Snapshot } from "./types.js";

// ─── Sandbox provider abstraction ─────────────────────────────────────────
// The agent never talks to mainnet — it talks to a Sandbox. MagicBlock
// Private ERs are the primary path; Surfpool is the local fallback used
// when the Magic Router is unreachable. Both are spun up per fuzz run
// and torn down at the end so nothing leaks.

export interface ProvisionRequest {
  snapshot: Snapshot;
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  provision(req: ProvisionRequest): Promise<Sandbox>;
}

// ─── MagicBlock Private Ephemeral Rollup (primary) ────────────────────────
// MagicBlock's model is a routing overlay, not a per-session validator
// spin-up. The Magic Router (a single HTTP endpoint, e.g.
// https://devnet.magicblock.app) selects the closest ER validator and
// transparently routes txs touching delegated accounts to that validator.
// Provisioning here means: open a connection to the router, verify
// connectivity by asking which validator we'll be pinned to, and (if
// configured) acquire a Private-ER auth token so the validator accepts
// our writes.
class MagicBlockProvider implements SandboxProvider {
  readonly kind = "magicblock" as const;

  async provision(_req: ProvisionRequest): Promise<Sandbox> {
    const routerUrl = requireEnv("MAGICBLOCK_ROUTER_URL");

    const connection = new Connection(routerUrl, "confirmed");

    let validator;
    try {
      validator = await getClosestValidator(connection);
    } catch (err) {
      throw new Error(
        `MagicBlock router unreachable at ${routerUrl}: ${(err as Error).message}`,
      );
    }

    // Optional: Private ER access control. When MAGICBLOCK_AUTH_KEYPAIR
    // points at a keypair file, we acquire a per-session auth token so
    // the validator gates our writes by signature instead of letting any
    // public tx touch the delegated state. The token is opaque to us;
    // we just hold it for the duration of the run.
    let authToken: string | undefined;
    const authPath = process.env.MAGICBLOCK_AUTH_KEYPAIR;
    if (authPath) {
      const kp = await loadKeypair(authPath);
      try {
        authToken = await getAuthToken(routerUrl, kp.publicKey, async (msg) =>
          nacl.sign.detached(msg, kp.secretKey),
        );
      } catch (err) {
        throw new Error(
          `MagicBlock private-ER auth failed for ${kp.publicKey.toBase58()}: ${(err as Error).message}`,
        );
      }
    }

    logger.info(
      {
        routerUrl,
        validator: validator.toBase58(),
        privateAuth: authToken ? "enabled" : "public",
      },
      "magicblock:provision",
    );

    return {
      kind: "magicblock",
      rpcUrl: routerUrl,
      validator,
      teardown: async () => {
        // No-op at the connection layer. Per-account delegation leases
        // are released by the fuzz loop's undelegate calls; if the loop
        // crashed mid-run, leases auto-expire after their commit_frequency
        // window, so nothing is permanently stuck.
        logger.info({ validator: validator.toBase58() }, "magicblock:teardown");
      },
    };
  }
}

// ─── Surfpool fallback ────────────────────────────────────────────────────
// Local mainnet-fork validator. Not private in the same sense — it just
// runs on the developer's box — but it lets the demo proceed offline and
// still hits realistic mainnet state.
class SurfpoolProvider implements SandboxProvider {
  readonly kind = "surfpool" as const;

  async provision(_req: ProvisionRequest): Promise<Sandbox> {
    const rpcUrl = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
    logger.warn({ rpcUrl }, "surfpool:provision (fallback)");
    // TODO(integration): exec `surfpool start --slot <snapshot.slot>` and
    // wait for RPC readiness. For now we assume a surfpool node is
    // already running on rpcUrl.
    return {
      kind: "surfpool",
      rpcUrl,
      teardown: async () => {
        logger.info({ rpcUrl }, "surfpool:teardown (no-op)");
      },
    };
  }
}

export function getSandboxProvider(kind: SandboxKind): SandboxProvider {
  switch (kind) {
    case "magicblock":
      return new MagicBlockProvider();
    case "surfpool":
      return new SurfpoolProvider();
  }
}

// Provision with automatic fallback: try MagicBlock first, drop to Surfpool
// if the primary provider fails. The CLI surfaces the actual sandbox used
// in the final report so the operator always knows. Per project policy
// the prize-eligible demo MUST land on MagicBlock; Surfpool is operator-
// triage only.
export async function provisionWithFallback(
  preferred: SandboxKind,
  req: ProvisionRequest,
): Promise<Sandbox> {
  if (preferred === "surfpool") return getSandboxProvider("surfpool").provision(req);
  try {
    return await getSandboxProvider("magicblock").provision(req);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "magicblock:provision-failed -> surfpool");
    return getSandboxProvider("surfpool").provision(req);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function loadKeypair(path: string): Promise<Keypair> {
  const raw = await readFile(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}
