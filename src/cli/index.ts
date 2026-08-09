import { runDatabaseGcCommand } from "./commands/db-gc.js";
import { runDatabaseMigrateCommand } from "./commands/db-migrate.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runPipelineCommand } from "./commands/pipeline.js";

function printHelp(): void {
  console.info(`Palimpsest

Available commands:
  doctor        Print resolved configuration and taxonomy summary
  db:migrate    Apply pending SQLite migrations
  db:gc         Delete aged analysis-run and LLM-cache rows (not artifact dirs)
  pipeline      Run canonical six stages: discover → scope → prepare → evidence → adjudicate → report
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

  if (command === "db:gc") {
    runDatabaseGcCommand(process.argv.slice(3));
    return;
  }

  if (command === "pipeline") {
    await runPipelineCommand(process.argv.slice(3));
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
