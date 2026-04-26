import { runFuzz } from "@shadow-fuzzer/agent";
import kleur from "kleur";
import ora from "ora";

interface RunOptions {
  rpc?: string;
  sandbox: "magicblock" | "surfpool";
  budget: number;
  parallel: number;
  reportDir: string;
  payer: string;
}

export async function runCommand(programId: string, opts: RunOptions): Promise<void> {
  if (!opts.rpc) {
    throw new Error("missing --rpc (or SOLANA_RPC_URL / HELIUS_RPC_URL)");
  }

  const spinner = ora({ text: "snapshot → sandbox → fuzz", color: "cyan" }).start();
  try {
    const report = await runFuzz({
      programId,
      rpcUrl: opts.rpc,
      sandbox: opts.sandbox,
      budgetTx: opts.budget,
      parallelism: opts.parallel,
      reportDir: opts.reportDir,
      payerKeypairPath: opts.payer,
    });
    spinner.succeed(
      `done — ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} (sandbox: ${report.config.sandbox})`,
    );

    if (report.findings.length === 0) {
      console.log(kleur.green("\n  no invariant violations under current budget."));
      return;
    }

    console.log("\n" + kleur.bold().red("findings:"));
    for (const f of report.findings) {
      console.log(`  ${kleur.red("✗")} ${kleur.bold(f.id)} [${f.severity}] ${f.title}`);
      console.log(`    ${kleur.dim(f.narrative)}`);
    }
    console.log(kleur.dim(`\n  full report → ${opts.reportDir}`));
  } catch (err) {
    spinner.fail((err as Error).message);
    throw err;
  }
}
