import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { buildReportInspectorRecords } from "../../contract/selectors.js";
import { loadReportChain } from "../../pipeline/report-chain.js";
import {
  AUTHOR_ANSWER_VERDICT,
  readAuthorReviewFile,
  selectAuthorReviewItems,
} from "../../review/author-review.js";
import { renderAuthorReviewPage } from "../../review/author-review-page.js";
import { resolveHumanReviewEventsPath } from "../../review/human-review-store.js";
import { getRunStage } from "../../storage/analysis-runs.js";
import { openDatabase } from "../../storage/database.js";
import { runMigrations } from "../../storage/migration-service.js";

const DEFAULT_FAITHFUL_SAMPLE = 5;

function usage(): string {
  return `Usage:
  author-review:export --run-id <id> [--out <file.html>] [--reader <name>] [--faithful <n>] [--exclude <itemId,...>]
      Write one HTML file for the seed paper's author: every restatement the
      run flagged plus <n> (default ${String(DEFAULT_FAITHFUL_SAMPLE)}) it judged faithful, shuffled.
      --exclude drops items found broken on inspection (ids are printed on
      export); the file records which were dropped.
  author-review:import --file <answered.html>
      Read a file the author saved and store their answers next to the report
      it was made from, printing their answers beside the tool's.`;
}

function fail(message: string): never {
  console.error(`${message}\n\n${usage()}`);
  process.exitCode = 1;
  throw new Error(message);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

function currentReportPath(runId: string): string {
  const database = openDatabase(
    createAppConfig(loadEnvironment()).databasePath,
  );
  try {
    runMigrations(database);
    const path = getRunStage(database, runId, "report")?.primaryArtifactPath;
    if (!path) fail(`Run ${runId} has no finished report`);
    return path;
  } finally {
    database.close();
  }
}

export function runAuthorReviewExportCommand(argv: readonly string[]): void {
  const runId = flagValue(argv, "--run-id") ?? fail("--run-id is required");
  const faithful = Number(
    flagValue(argv, "--faithful") ?? DEFAULT_FAITHFUL_SAMPLE,
  );
  if (!Number.isInteger(faithful) || faithful < 0)
    fail("--faithful must be a whole number");
  const readerName = flagValue(argv, "--reader");
  const excludeItemIds = (flagValue(argv, "--exclude") ?? "")
    .split(",")
    .map((itemId) => itemId.trim())
    .filter((itemId) => itemId.length > 0);

  const { chain, runRoot } = loadReportChain(currentReportPath(runId));
  const rows = buildReportInspectorRecords(chain);
  const { items, restatementCount, unknownExclusions } =
    selectAuthorReviewItems({
      rows,
      faithfulSample: faithful,
      sampleKey: chain.report.contentHash,
      excludeItemIds,
    });
  if (unknownExclusions.length > 0)
    fail(`--exclude names no item: ${unknownExclusions.join(", ")}`);
  if (items.length === 0) fail("The report has no adjudicated restatements");

  const html = renderAuthorReviewPage({
    schemaVersion: "author-review-v1",
    lineage: {
      runId,
      reportArtifactId: chain.report.artifactId,
      reportContentHash: chain.report.contentHash,
    },
    seedTitle: rows[0]?.seedTitle ?? "",
    ...(readerName ? { readerName } : {}),
    restatementCount,
    ...(excludeItemIds.length > 0 ? { excludedItemIds: excludeItemIds } : {}),
    items,
  });
  const out = resolve(
    flagValue(argv, "--out") ??
      join(runRoot, "review", chain.report.artifactId, "author-review.html"),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  const flagged = items.filter((item) => item.ours.verdict !== "F").length;
  items.forEach((item, index) =>
    console.info(
      `${String(index + 1).padStart(3)}  ${item.ours.verdict}  ${item.itemId}  ${item.citingPaperTitle.slice(0, 60)}`,
    ),
  );
  console.info(
    `Wrote ${String(items.length)} items (${String(flagged)} flagged, ${String(items.length - flagged)} faithful) of ${String(restatementCount)} restatements${excludeItemIds.length > 0 ? `, ${String(excludeItemIds.length)} excluded` : ""} to ${out}`,
  );
}

export function runAuthorReviewImportCommand(argv: readonly string[]): void {
  const file = flagValue(argv, "--file") ?? fail("--file is required");
  const read = readAuthorReviewFile(readFileSync(resolve(file), "utf8"));
  if (!read.ok) fail(`Not a readable author review file: ${read.error}`);
  const { data, answers } = read;

  const runRoot = dirname(dirname(currentReportPath(data.lineage.runId)));
  const reviewDir = dirname(
    resolveHumanReviewEventsPath({
      runRoot,
      reportArtifactId: data.lineage.reportArtifactId,
    }),
  );
  const importedAt = new Date().toISOString();
  const stored = {
    schemaVersion: "author-review-answers-v1",
    lineage: data.lineage,
    ...(data.readerName ? { reader: data.readerName } : {}),
    importedAt,
    items: data.items.map((item) => ({
      itemId: item.itemId,
      recordIds: item.recordIds,
      machineVerdict: item.ours.verdict,
      answer: answers[item.itemId] ?? null,
    })),
  };
  const out = join(
    reviewDir,
    "author-reviews",
    `${importedAt.replaceAll(":", "-")}.json`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  let agreed = 0;
  let answered = 0;
  for (const item of data.items) {
    const answer = answers[item.itemId];
    const theirs = answer
      ? `${AUTHOR_ANSWER_VERDICT[answer.first]}${answer.final !== answer.first ? `→${AUTHOR_ANSWER_VERDICT[answer.final]}` : ""}`
      : "-";
    if (answer) {
      answered += 1;
      if (AUTHOR_ANSWER_VERDICT[answer.first] === item.ours.verdict)
        agreed += 1;
    }
    console.info(
      `${item.ours.verdict} vs ${theirs.padEnd(4)} ${item.citingPaperTitle.slice(0, 70)}${answer?.note ? `\n           note: ${answer.note}` : ""}`,
    );
  }
  console.info(
    `\nAgreed on ${String(agreed)} of ${String(answered)} answered (blind first answers). Stored at ${out}`,
  );
}
