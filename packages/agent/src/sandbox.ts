import { logger } from "./logger.js";
import type { Sandbox, SandboxKind, Snapshot } from "./types.js";

// ─── Sandbox provider abstraction ─────────────────────────────────────────
// The agent never talks to mainnet — it talks to a Sandbox. MagicBlock
// Private ERs are the primary path; Surfpool is the local fallback used
// when MagicBlock provisioning is unavailable. Both are spun up per fuzz
// run and torn down at the end so nothing leaks.

export interface ProvisionRequest {
  snapshot: Snapshot;
  region?: string;
}

export interface SandboxProvider {
  readonly kind: SandboxKind;
  provision(req: ProvisionRequest): Promise<Sandbox>;
}

// ─── MagicBlock Private Ephemeral Rollup (primary) ────────────────────────
class MagicBlockProvider implements SandboxProvider {
  readonly kind = "magicblock" as const;

  async provision(req: ProvisionRequest): Promise<Sandbox> {
    const providerUrl = requireEnv("MAGICBLOCK_PROVIDER_URL");
    const apiKey = requireEnv("MAGICBLOCK_API_KEY");
    const region = req.region ?? process.env.MAGICBLOCK_VALIDATOR_REGION ?? "us-east";

    logger.info({ region, slot: req.snapshot.slot.toString() }, "magicblock:provision");

    // The actual provisioning call is made via @magicblock-labs/ephemeral-
    // rollups-sdk. We keep the wire details in one place so the rest of
    // the agent only sees a Sandbox handle.
    //
    // TODO(integration): replace this stub with the SDK call once we wire
    // credentials. Contract: must return an RPC URL pointing at a private
    // validator that has been seeded with `req.snapshot`.
    const rollupId = `mb-${Date.now().toString(36)}`;
    const rpcUrl = `${providerUrl.replace(/\/$/, "")}/rollup/${rollupId}/rpc`;

    return {
      kind: "magicblock",
      rpcUrl,
      teardown: async () => {
        logger.info({ rollupId }, "magicblock:teardown");
        // TODO(integration): SDK call to destroy the private rollup.
      },
    };
    // touch apiKey so TS doesn't complain in stub form
    void apiKey;
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
// in the final report so the operator always knows.
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
