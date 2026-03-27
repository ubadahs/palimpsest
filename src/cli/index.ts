import { runDatabaseMigrateCommand } from "./commands/db-migrate.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runM2ExtractCommand } from "./commands/m2-extract.js";
import { runM3ClassifyCommand } from "./commands/m3-classify.js";
import { runM4EvidenceCommand } from "./commands/m4-evidence.js";
import { runM5AdjudicateCommand } from "./commands/m5-adjudicate.js";
import { runM6LlmAdjudicateCommand } from "./commands/m6-llm-adjudicate.js";
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
`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  if (command === "doctor") {
    runDoctorCommand();
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
    await runM6LlmAdjudicateCommand(process.argv.slice(3));
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
