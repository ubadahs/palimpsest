import { runDatabaseMigrateCommand } from "./commands/db-migrate.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runPipelineCommand } from "./commands/pipeline.js";

function printHelp(): void {
  console.info(`Palimpsest

Available commands:
  doctor        Print resolved configuration and taxonomy summary
  db:migrate    Apply pending SQLite migrations
  pipeline      Run canonical six stages: discover → scope → prepare → evidence → adjudicate → report

Unsupported legacy commands:
  discover, pre-screen, screen, extract, classify, evidence, curate, adjudicate
  benchmark:blind, benchmark:diff, benchmark:apply, benchmark:summary
  Use "pipeline --input <dois.json>" for the canonical workflow.
  Blinded evaluation tooling will return once it consumes canonical F/D/E/U artifacts.
`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.info("palimpsest 0.1.0");
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand();
    return;
  }

  if (command === "db:migrate") {
    runDatabaseMigrateCommand();
    return;
  }

  if (command === "pipeline") {
    await runPipelineCommand(process.argv.slice(3));
    return;
  }

  if (
    [
      "discover",
      "pre-screen",
      "screen",
      "extract",
      "classify",
      "evidence",
      "curate",
      "adjudicate",
      "benchmark:blind",
      "benchmark:diff",
      "benchmark:apply",
      "benchmark:summary",
    ].includes(command)
  ) {
    console.error(
      `"${command}" is unsupported. The public CLI supports only the canonical pipeline; run "pipeline --input <dois.json>".`,
    );
    process.exitCode = 1;
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
