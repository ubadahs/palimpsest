import { runBenchmarkApplyCommand } from "./commands/benchmark-apply.js";
import { runBenchmarkBlindCommand } from "./commands/benchmark-blind.js";
import { runBenchmarkDiffCommand } from "./commands/benchmark-diff.js";
import { runBenchmarkSummaryCommand } from "./commands/benchmark-summary.js";
import { runDatabaseMigrateCommand } from "./commands/db-migrate.js";
import { runDiscoverCommand } from "./commands/discover.js";
import { runPipelineCommand } from "./commands/pipeline.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runExtractCommand } from "./commands/extract.js";
import { runClassifyCommand } from "./commands/classify.js";
import { runEvidenceCommand } from "./commands/evidence.js";
import { runCurateCommand } from "./commands/curate.js";
import { runAdjudicateCommand } from "./commands/adjudicate.js";
import { runPreScreenCommand } from "./commands/screen.js";

function printHelp(): void {
  console.info(`Palimpsest

Available commands:
  doctor        Print resolved configuration and taxonomy summary
  db:migrate    Apply pending SQLite migrations
  discover      Discover claim families from citing behavior, ground to seed, emit shortlist (needs ANTHROPIC_API_KEY)
  pipeline      Run full e2e: discover → screen → extract → classify → evidence → curate → adjudicate
  screen        Screen claim families (LLM full-doc claim grounding + trace sidecar; needs ANTHROPIC_API_KEY)
  extract       Extract citation contexts for a single claim family
  classify      Classify citation functions and build edge evaluation packets
  evidence      Retrieve evidence from cited paper for evaluation tasks
  curate        Build a balanced calibration sample from evidence-backed tasks
  adjudicate    Run LLM adjudication against calibration set
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

  if (command === "discover") {
    await runDiscoverCommand(process.argv.slice(3));
    return;
  }

  if (command === "pipeline") {
    await runPipelineCommand(process.argv.slice(3));
    return;
  }

  if (command === "screen" || command === "pre-screen") {
    await runPreScreenCommand(process.argv.slice(3));
    return;
  }

  if (command === "extract") {
    await runExtractCommand(process.argv.slice(3));
    return;
  }

  if (command === "classify") {
    runClassifyCommand(process.argv.slice(3));
    return;
  }

  if (command === "evidence") {
    await runEvidenceCommand(process.argv.slice(3));
    return;
  }

  if (command === "curate") {
    runCurateCommand(process.argv.slice(3));
    return;
  }

  if (command === "adjudicate") {
    await runAdjudicateCommand(process.argv.slice(3));
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
