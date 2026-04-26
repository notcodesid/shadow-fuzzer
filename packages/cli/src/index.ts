import "dotenv/config";

import { Command } from "commander";
import kleur from "kleur";

import { runCommand } from "./commands/run.js";

const program = new Command()
  .name("shadow-fuzz")
  .description("Private sandbox fuzzer for Solana programs.")
  .version("0.1.0");

program
  .command("run")
  .description("Snapshot a target program, provision a private sandbox, and fuzz it.")
  .argument("<program-id>", "the Solana program to target")
  .option("--rpc <url>", "RPC URL to snapshot from", process.env.SOLANA_RPC_URL)
  .option(
    "--sandbox <kind>",
    "magicblock | surfpool (auto-falls-back to surfpool on failure)",
    process.env.SHADOW_SANDBOX ?? "magicblock",
  )
  .option("--budget <n>", "max txs to submit", (v) => Number.parseInt(v, 10), 2000)
  .option("--parallel <n>", "concurrent attackers", (v) => Number.parseInt(v, 10), 8)
  .option("--report-dir <path>", "where to write reports", process.env.SHADOW_REPORT_DIR ?? "./reports")
  .option("--payer <path>", "path to fuzz payer keypair", process.env.FUZZ_PAYER_KEYPAIR ?? "./.shadow-fuzzer/fuzz-payer.json")
  .action(runCommand);

program.parseAsync().catch((err) => {
  const e = err as Error;
  console.error(kleur.red(`shadow-fuzz: ${e.message}`));
  if (process.env.SHADOW_DEBUG) {
    console.error(e.stack);
  }
  process.exitCode = 1;
});
