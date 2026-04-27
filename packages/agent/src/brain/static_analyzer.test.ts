import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { analyzeIdl, type Candidate } from "./static_analyzer.js";

// Read the bundled IDL from the CLI's assets directory rather than
// `target/idl/` so the test doesn't depend on a fresh `anchor build`
// having run in the working tree. The bundled copy is the canonical
// artifact the published CLI ships.
const VAULT_IDL_PATH = resolve(__dirname, "../../../cli/assets/vulnerable_vault.json");

describe("analyzeIdl", () => {
  it("flags the missing-signer pattern on `withdraw` from the real IDL", async () => {
    const idl = JSON.parse(await readFile(VAULT_IDL_PATH, "utf8"));
    const candidates = analyzeIdl(idl);

    const withdrawCandidates = candidates.filter(
      (c) => c.instructionName === "withdraw" && c.kind === "MISSING_SIGNER",
    );
    expect(withdrawCandidates).toHaveLength(1);
    const [withdraw] = withdrawCandidates;
    if (!withdraw) throw new Error("unreachable: length asserted above");
    expect(withdraw.accountName).toBe("owner");
    expect(withdraw.reasoning.toLowerCase()).toContain("signer");
  });

  it("does NOT flag `deposit` (it has the has_one constraint that withdraw lacks)", async () => {
    const idl = JSON.parse(await readFile(VAULT_IDL_PATH, "utf8"));
    const candidates = analyzeIdl(idl);
    const depositCandidates = candidates.filter((c) => c.instructionName === "deposit");
    expect(depositCandidates).toHaveLength(0);
  });

  it("does NOT flag `initialize_vault` (authority is a signer)", async () => {
    const idl = JSON.parse(await readFile(VAULT_IDL_PATH, "utf8"));
    const candidates = analyzeIdl(idl);
    const initCandidates = candidates.filter(
      (c) => c.instructionName === "initialize_vault",
    );
    expect(initCandidates).toHaveLength(0);
  });

  it("ignores ix where no PDA seed references the owner-like account (avoids over-firing on global config admins)", () => {
    // Cast through `unknown` — analyzeIdl reads the IDL defensively,
    // we don't need to satisfy every Anchor IDL field for this test.
    const fakeIdl = {
      version: "0.1.0",
      name: "fake",
      instructions: [
        {
          name: "set_admin",
          discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
          accounts: [
            { name: "new_admin" },
            { name: "config", writable: true },
          ],
          args: [],
        },
      ],
    } as unknown as Parameters<typeof analyzeIdl>[0];

    const candidates: Candidate[] = analyzeIdl(fakeIdl);
    expect(candidates).toHaveLength(0);
  });
});
