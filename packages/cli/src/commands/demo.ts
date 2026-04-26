import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runFuzz } from "@shadow-fuzzer/agent";
import kleur from "kleur";
import ora from "ora";

import { checkSolanaCli, spawnLocalValidator } from "../util/validator.js";

interface DemoOptions {
  reportDir: string;
  budget: number;
}

const PROGRAM_ID = "CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC";

// The `demo` subcommand is the zero-friction onboarding path: it spawns
// a local solana-test-validator with the bundled vulnerable_vault binary
// preloaded, points the agent at it, and lets the operator watch BUG #2
// get rediscovered live. No external program deployment, no devnet SOL,
// no Magic Router credentials — just `shadow-fuzz demo` and a report.
//
// The full `run <program-id>` command stays available for users who
// have their own deployed Anchor program to fuzz.
export async function demoCommand(opts: DemoOptions): Promise<void> {
  // Cheap fail-fast before we burn cycles spawning anything.
  const cliCheck = checkSolanaCli();
  if (!cliCheck.ok) {
    console.error(kleur.red(`shadow-fuzz: ${cliCheck.hint}`));
    process.exitCode = 1;
    return;
  }

  // Resolve bundled assets relative to the package root, not the user's
  // cwd — the demo has to work from anywhere `shadow-fuzz` is on PATH.
  const here = dirname(fileURLToPath(import.meta.url));
  const programSoPath = resolve(here, "..", "..", "assets", "vulnerable_vault.so");
  const idlPath = resolve(here, "..", "..", "assets", "vulnerable_vault.json");

  console.log(
    kleur.dim(
      "shadow-fuzz demo — boots a local validator with a vulnerable vault\n" +
        "preloaded, then lets the agent rediscover the planted bug autonomously.\n",
    ),
  );

  const spinner = ora({ text: "spawning local validator…", color: "cyan" }).start();
  let validator;
  try {
    validator = await spawnLocalValidator({ programSoPath });
    spinner.succeed(`local validator ready (rpc ${validator.rpcUrl})`);
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // The agent reads the IDL from SHADOW_IDL_PATH (overrides the cwd
  // default). For the demo subcommand the IDL is bundled in the package,
  // not in the user's filesystem, so we point at the bundled copy.
  process.env.SHADOW_IDL_PATH = idlPath;

  mkdirSync(opts.reportDir, { recursive: true });

  const fuzzSpinner = ora({ text: "agent: snapshot → analyze → exploit", color: "cyan" }).start();
  try {
    const report = await runFuzz({
      programId: PROGRAM_ID,
      rpcUrl: validator.rpcUrl,
      sandbox: "surfpool",
      budgetTx: opts.budget,
      parallelism: 1,
      reportDir: opts.reportDir,
      payerKeypairPath: validator.payerKeypairPath,
    });

    if (report.findings.length > 0) {
      fuzzSpinner.succeed(
        `done — ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} (${report.txsLanded}/${report.txsAttempted} exploit txs landed)`,
      );
    } else {
      fuzzSpinner.warn(
        "done — no findings (the static analyzer flagged nothing or every candidate was refuted)",
      );
    }

    for (const f of report.findings) {
      console.log(
        `\n  ${kleur.red("✗")} ${kleur.bold(f.id)} ${kleur.gray(`[${f.severity}]`)} ${f.title}`,
      );
      const firstParagraph = f.narrative.split("\n\n")[0] ?? f.narrative;
      console.log(kleur.gray("    " + firstParagraph.replace(/\n/g, "\n    ")));
    }

    console.log(kleur.dim(`\n  full report → ${opts.reportDir}`));
  } catch (err) {
    fuzzSpinner.fail((err as Error).message);
    if (process.env.SHADOW_DEBUG) console.error((err as Error).stack);
    process.exitCode = 1;
  } finally {
    await validator.teardown().catch(() => {
      /* validator already gone */
    });
    // Force exit: @solana/web3.js's WebSocket subscriptions hold the event
    // loop open after the validator is killed, spamming ECONNREFUSED. All
    // work is done at this point so a hard exit is the right call.
    process.exit(process.exitCode ?? 0);
  }
}
