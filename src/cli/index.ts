import { runBenchmarkApplyCommand } from "./commands/benchmark-apply.js";
import { runBenchmarkBlindCommand } from "./commands/benchmark-blind.js";
import { runBenchmarkDiffCommand } from "./commands/benchmark-diff.js";
import { runBenchmarkSummaryCommand } from "./commands/benchmark-summary.js";
import { runDatabaseMigrateCommand } from "./commands/db-migrate.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runM2ExtractCommand } from "./commands/m2-extract.js";
import { runM3ClassifyCommand } from "./commands/m3-classify.js";
import { runM4EvidenceCommand } from "./commands/m4-evidence.js";
import { runM5AdjudicateCommand } from "./commands/m5-adjudicate.js";
import { runM6LlmJudgeCommand } from "./commands/m6-llm-judge.js";
import { runPreScreenCommand } from "./commands/pre-screen.js";

function printHelp(): void {
  console.info(`Citation Fidelity Analyzer

Available commands:
  doctor        Print resolved configuration and taxonomy summary
  db:migrate    Apply pending SQLite migrations
  pre-screen    Pre-screen candidate claim families for auditability
  m2-extract    Extract citation contexts for a single claim family
  m3-classify   Classify citation functions and build edge evaluation packets
  m4-evidence   Retrieve evidence from cited paper for evaluation tasks
  m5-adjudicate Generate calibration worksheet for human adjudication
  m6-llm-judge  Run LLM adjudication against calibration set
  benchmark:blind Create a blinded benchmark export from an adjudicated set
  benchmark:diff  Compare two adjudication datasets keyed by taskId
  benchmark:apply Apply approved adjudication deltas to a base dataset
  benchmark:summary Rank one or more adjudication candidates against a base dataset
`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  if (command === "doctor") {
    await runDoctorCommand();
    return;
  }

  if (command === "benchmark:blind") {
    runBenchmarkBlindCommand(process.argv.slice(3));
    return;
  }

  if (command === "benchmark:diff") {
    runBenchmarkDiffCommand(process.argv.slice(3));
    return;
  }

  if (command === "benchmark:apply") {
    runBenchmarkApplyCommand(process.argv.slice(3));
    return;
  }

  if (command === "benchmark:summary") {
    runBenchmarkSummaryCommand(process.argv.slice(3));
    return;
  }

  if (command === "db:migrate") {
    runDatabaseMigrateCommand();
    return;
  }

  if (command === "pre-screen") {
    await runPreScreenCommand(process.argv.slice(3));
    return;
  }

  if (command === "m2-extract") {
    await runM2ExtractCommand(process.argv.slice(3));
    return;
  }

  if (command === "m3-classify") {
    runM3ClassifyCommand(process.argv.slice(3));
    return;
  }

  if (command === "m4-evidence") {
    await runM4EvidenceCommand(process.argv.slice(3));
    return;
  }

  if (command === "m5-adjudicate") {
    runM5AdjudicateCommand(process.argv.slice(3));
    return;
  }

  if (command === "m6-llm-judge") {
    await runM6LlmJudgeCommand(process.argv.slice(3));
    return;
  }

  if (command === "help") {
    printHelp();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

void main();
