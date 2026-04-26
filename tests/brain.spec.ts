import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";

import { runFuzz } from "../packages/agent/src/index.js";

import { getProvider } from "./setup.js";

// ─── Brain end-to-end acceptance ──────────────────────────────────────────
// Acceptance criterion for step 5: the agent rediscovers BUG #2 from the
// program's IDL alone — no peeking at tests/vault.spec.ts. We exercise
// runFuzz end-to-end against the same local validator the exploit suite
// uses, in the surfpool branch (sandbox="surfpool"), so the test stays
// deterministic and offline.
//
// `sandbox: magicblock` is the prize-eligible path and is exercised by
// hand against a real Magic Router during the demo recording step.

const VAULT_PROGRAM_ID = "CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC";

describe("brain — end-to-end fuzz against local validator", () => {
  let rpcUrl: string;
  let payerKeypairPath: string;
  let reportDir: string;

  beforeAll(() => {
    const provider = getProvider();
    rpcUrl = provider.connection.rpcEndpoint;
    // Reuse the wallet keypair anchor test already wrote — same payer
    // that ran initialize_vault during deploy. The agent will create
    // fresh users for victim/attacker; the test wallet just funds them.
    payerKeypairPath =
      process.env.ANCHOR_WALLET ?? `${process.env.HOME ?? ""}/.config/solana/id.json`;
    reportDir = mkdtempSync(join(tmpdir(), "shadow-fuzz-brain-"));

    // Route the surfpool sandbox path at the local test validator instead
    // of expecting a separately-running surfpool node.
    process.env.SURFPOOL_RPC_URL = rpcUrl;
  });

  it("rediscovers BUG #2 (missing signer on withdraw) from the IDL alone", async () => {
    const report = await runFuzz({
      programId: VAULT_PROGRAM_ID,
      rpcUrl,
      sandbox: "surfpool",
      budgetTx: 50,
      parallelism: 1,
      reportDir,
      payerKeypairPath,
    });

    expect(report.findings.length).toBeGreaterThanOrEqual(1);

    const inv3 = report.findings.find((f) => f.invariant === "INV-3");
    expect(inv3, "expected at least one INV-3 finding").toBeDefined();
    if (!inv3) throw new Error("unreachable");

    expect(inv3.severity).toBe("critical");
    expect(inv3.title.toLowerCase()).toContain("withdraw");
    expect(inv3.evidenceTxs.length).toBeGreaterThanOrEqual(1);
    expect(inv3.narrative.toLowerCase()).toContain("attacker");
  }, 60_000);
});
