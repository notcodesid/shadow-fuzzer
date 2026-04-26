import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "./logger.js";
import type { FuzzReport } from "./types.js";

export async function writeReport(dir: string, report: FuzzReport): Promise<{ json: string; md: string }> {
  await mkdir(dir, { recursive: true });
  const stamp = new Date(report.endedAtMs).toISOString().replace(/[:.]/g, "-");
  const base = `report-${stamp}`;
  const jsonPath = join(dir, `${base}.json`);
  const mdPath = join(dir, `${base}.md`);

  await writeFile(
    jsonPath,
    JSON.stringify(
      report,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  await writeFile(mdPath, renderMarkdown(report));

  logger.info({ jsonPath, mdPath, findings: report.findings.length }, "report:written");
  return { json: jsonPath, md: mdPath };
}

function renderMarkdown(r: FuzzReport): string {
  const dur = ((r.endedAtMs - r.startedAtMs) / 1000).toFixed(1);
  const sandboxLine = r.validator
    ? `- **sandbox:** ${r.config.sandbox} (validator \`${r.validator}\`)`
    : `- **sandbox:** ${r.config.sandbox}`;
  const head = [
    `# Shadow Fuzzer report`,
    ``,
    `- **target:** \`${r.config.programId.toBase58()}\``,
    sandboxLine,
    `- **snapshot slot:** ${r.snapshotSlot}`,
    `- **txs attempted / landed:** ${r.txsAttempted} / ${r.txsLanded}`,
    `- **wall time:** ${dur}s`,
    `- **findings:** ${r.findings.length}`,
    ``,
  ].join("\n");

  if (r.findings.length === 0) {
    return `${head}\n_No invariant violations under the current budget._\n`;
  }

  const body = r.findings
    .map((f) => {
      return [
        `## ${f.id} — ${f.title}`,
        ``,
        `- **invariant:** ${f.invariant}`,
        `- **severity:** ${f.severity}`,
        `- **evidence txs:** ${f.evidenceTxs.length === 0 ? "_(none captured)_" : f.evidenceTxs.map((t) => `\`${t}\``).join(", ")}`,
        ``,
        f.narrative,
        ``,
      ].join("\n");
    })
    .join("\n");

  return `${head}\n${body}`;
}
