import type { Idl } from "@coral-xyz/anchor";

// The static analyzer walks a program's Anchor IDL and flags account
// shapes that smell like missing access control. We deliberately keep
// the rule set narrow and high-precision — the goal is to avoid noise
// in the report so each candidate is worth running an exploit against.
//
// Today: one heuristic — MISSING_SIGNER. Future passes will add more
// (unchecked arithmetic via Rust source, mint/account confusion via
// constraint analysis, etc.) without changing this module's contract.

export type CandidateKind = "MISSING_SIGNER";

export interface MissingSignerCandidate {
  kind: "MISSING_SIGNER";
  instructionName: string;
  accountName: string;
  reasoning: string;
}

export type Candidate = MissingSignerCandidate;

// Account names that, by convention, identify a privileged role whose
// authorization should be enforced. Anchor's `has_one` constraint or a
// `Signer<'info>` wrapper would normally cover this; missing both is the
// classic "anyone can drain" pattern.
const OWNER_LIKE_NAMES = [
  "owner",
  "authority",
  "admin",
  "creator",
  "delegate",
  "manager",
];

export function analyzeIdl(idl: Idl): Candidate[] {
  const candidates: Candidate[] = [];

  for (const ix of idl.instructions ?? []) {
    for (const account of ix.accounts ?? []) {
      const accountName = account.name ?? "";
      const lower = accountName.toLowerCase();
      if (!OWNER_LIKE_NAMES.some((n) => lower.includes(n))) continue;

      const isSigner = readBool(account, "signer");
      const hasRelations =
        Array.isArray((account as { relations?: unknown[] }).relations) &&
        ((account as { relations: unknown[] }).relations).length > 0;

      if (isSigner || hasRelations) continue;

      // Tightening signal: another account in the same ix uses this
      // account's pubkey as a PDA seed. That tells us the program *does*
      // treat this account as identifying a particular user — so the
      // missing signer/has_one is almost certainly a bug, not a
      // public-helper pattern (e.g. a global config admin pubkey).
      const referencedBySeeds = (ix.accounts ?? []).some((other) =>
        accountReferencedAsPdaSeed(other, accountName),
      );
      if (!referencedBySeeds) continue;

      candidates.push({
        kind: "MISSING_SIGNER",
        instructionName: ix.name,
        accountName,
        reasoning:
          `Instruction \`${ix.name}\` reads \`${accountName}\` as the privileged role for at least one PDA-derived account, ` +
          `but \`${accountName}\` is neither marked as a signer nor verified through a \`has_one\` / \`relations\` constraint. ` +
          `Any caller can pass an arbitrary pubkey here and the runtime will accept it, letting them act on that role's behalf.`,
      });
    }
  }

  return candidates;
}

function readBool(obj: unknown, key: string): boolean {
  if (obj && typeof obj === "object" && key in obj) {
    return (obj as Record<string, unknown>)[key] === true;
  }
  return false;
}

function accountReferencedAsPdaSeed(account: unknown, targetName: string): boolean {
  if (!account || typeof account !== "object") return false;
  const pda = (account as { pda?: unknown }).pda;
  if (!pda || typeof pda !== "object") return false;
  const seeds = (pda as { seeds?: unknown[] }).seeds;
  if (!Array.isArray(seeds)) return false;
  return seeds.some((seed) => {
    if (!seed || typeof seed !== "object") return false;
    const s = seed as { kind?: unknown; path?: unknown };
    return s.kind === "account" && s.path === targetName;
  });
}
