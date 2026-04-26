import "dotenv/config";

import { Command } from "commander";
import kleur from "kleur";

import { demoCommand } from "./commands/demo.js";
import { runCommand } from "./commands/run.js";

const program = new Command()
  .name("shadow-fuzz")
  .description("Private sandbox fuzzer for Solana programs.")
  .version("0.1.0");

program
  .command("demo")
  .description(
    "Boot a local validator with a bundled vulnerable program and let the agent rediscover the bug autonomously.",
  )
  .option("--report-dir <path>", "where to write reports", "./reports")
  .option("--budget <n>", "max txs to submit", (v) => Number.parseInt(v, 10), 50)
  .action(demoCommand);

program
  .command("run")
  .description(
    "Snapshot a target program, provision a private sandbox, and fuzz it. Today's brain looks for missing-signer / has_one bugs in Anchor programs that follow common vault patterns.",
  )
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
  .option(
    "--payer <path>",
    "path to fuzz payer keypair",
    process.env.FUZZ_PAYER_KEYPAIR ?? "./.shadow-fuzzer/fuzz-payer.json",
  )
  .action(runCommand);

program.parseAsync().catch((err) => {
  const e = err as Error;
  console.error(kleur.red(`shadow-fuzz: ${e.message}`));
  if (process.env.SHADOW_DEBUG) {
    console.error(e.stack);
  }
  process.exitCode = 1;
});
