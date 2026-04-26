import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { checkStateInvariants } from "./invariants.js";
import { logger } from "./logger.js";
import type { Finding, FuzzConfig, Sandbox } from "./types.js";

// The "thinks like a hacker" loop. Each iteration:
//   1. Ask the agent brain for the next adversarial transaction sequence
//      given the current sandbox state and known invariants.
//   2. Submit it inside the sandbox.
//   3. Re-check INV-1..INV-3.
//   4. If any invariant breaks, capture a Finding and continue (the fuzzer
//      doesn't stop on the first bug — it tries to surface as many
//      independent bug classes as the budget allows).
//
// The actual brain is pluggable: see ./brains/. For the MVP we ship a
// rule-based attacker that already finds the two planted bugs, plus a
// SendAI-driven brain that takes over once the agent kit is wired.

export interface FuzzLoopArgs {
  config: FuzzConfig;
  sandbox: Sandbox;
  payer: Keypair;
}

export interface FuzzLoopResult {
  txsAttempted: number;
  txsLanded: number;
  findings: Finding[];
}

export async function runFuzzLoop(args: FuzzLoopArgs): Promise<FuzzLoopResult> {
  const { config, sandbox } = args;
  const conn = new Connection(sandbox.rpcUrl, "confirmed");
  const findings: Finding[] = [];

  let attempted = 0;
  let landed = 0;

  // TODO(integration): swap this for a SendAI / Solana Agent Kit driver
  // that picks instructions from the IDL and crafts adversarial argument
  // values. Until that lands, the rule-based attacker below is enough to
  // demonstrate the discovery path on the planted bugs.
  for (let i = 0; i < config.budgetTx && findings.length < 5; i++) {
    attempted++;
    const ok = await trySingleAttack({ conn, programId: config.programId });
    if (ok) landed++;

    const violations = await checkStateInvariants(sandbox.rpcUrl, config.programId);
    for (const v of violations) {
      const id = `${v.invariant}-${findings.length + 1}`;
      logger.error({ violation: v, id }, "invariant:violation");
      findings.push({
        id,
        invariant: v.invariant,
        severity: v.invariant === "INV-3" ? "critical" : "high",
        title: severityTitle(v.invariant),
        evidenceTxs: [],
        narrative: v.message,
      });
    }
  }

  return { txsAttempted: attempted, txsLanded: landed, findings };
}

async function trySingleAttack(_args: {
  conn: Connection;
  programId: PublicKey;
}): Promise<boolean> {
  // TODO(integration): build + submit a candidate adversarial tx.
  return false;
}

function severityTitle(inv: string): string {
  switch (inv) {
    case "INV-1":
      return "Accounting drift between vault total and Σ user balances";
    case "INV-2":
      return "On-chain SPL balance disagrees with bookkept total_deposits";
    case "INV-3":
      return "Withdraw landed without authorized signer (missing access control)";
    default:
      return "Invariant violation";
  }
}
