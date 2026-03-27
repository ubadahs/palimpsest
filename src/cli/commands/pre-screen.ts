import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAppConfig } from "../../config/app-config.js";
import { loadEnvironment } from "../../config/env.js";
import { shortlistInputSchema } from "../../domain/types.js";
import * as openalex from "../../integrations/openalex.js";
import * as semanticScholar from "../../integrations/semantic-scholar.js";
import {
  runPreScreen,
  type PreScreenAdapters,
} from "../../pipeline/pre-screen.js";
import {
  toPreScreenJson,
  toPreScreenMarkdown,
} from "../../reporting/pre-screen-report.js";
import { nextRunStamp } from "../run-stamp.js";

function parseArgs(argv: string[]): { input: string; output: string } {
  let input: string | undefined;
  let output = "data/pre-screen";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (arg === "--output" && i + 1 < argv.length) {
      output = argv[i + 1]!;
      i++;
    }
  }

  if (!input) {
    console.error("Missing required --input <path> argument");
    process.exitCode = 1;
    throw new Error("Missing --input");
  }

  return { input, output };
}

function buildAdapters(config: {
  baseUrls: { openAlex: string; semanticScholar: string };
  openAlexEmail: string | undefined;
  semanticScholarApiKey: string | undefined;
}): PreScreenAdapters {
  return {
    resolveByDoi: async (doi) => {
      const oaResult = await openalex.resolveWorkByDoi(
        doi,
        config.baseUrls.openAlex,
        config.openAlexEmail,
      );
      if (oaResult.ok) return oaResult;
      return semanticScholar.resolvePaperByDoi(
        doi,
        config.baseUrls.semanticScholar,
        config.semanticScholarApiKey,
      );
    },
    getCitingPapers: (openAlexId) =>
      openalex.getCitingWorks(
        openAlexId,
        config.baseUrls.openAlex,
        50,
        config.openAlexEmail,
      ),
    findPublishedVersion: (title, excludeId) =>
      openalex.findPublishedVersion(
        title,
        excludeId,
        config.baseUrls.openAlex,
        config.openAlexEmail,
      ),
  };
}

export async function runPreScreenCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const environment = loadEnvironment();
  const config = createAppConfig(environment);

  const rawInput: unknown = JSON.parse(readFileSync(args.input, "utf8"));
  const parseResult = shortlistInputSchema.safeParse(rawInput);

  if (!parseResult.success) {
    console.error("Invalid shortlist input:", parseResult.error.message);
    process.exitCode = 1;
    return;
  }

  const shortlist = parseResult.data;
  console.info(`Processing ${String(shortlist.seeds.length)} seed(s)...`);

  const adapters = buildAdapters({
    baseUrls: config.providerBaseUrls,
    openAlexEmail: config.openAlexEmail,
    semanticScholarApiKey: config.semanticScholarApiKey,
  });
  const results = await runPreScreen(shortlist.seeds, adapters);

  const outputDir = resolve(process.cwd(), args.output);
  mkdirSync(outputDir, { recursive: true });

  const stamp = nextRunStamp(outputDir);
  const jsonPath = resolve(outputDir, `${stamp}_pre-screen-results.json`);
  const mdPath = resolve(outputDir, `${stamp}_pre-screen-report.md`);

  writeFileSync(jsonPath, toPreScreenJson(results), "utf8");
  writeFileSync(mdPath, toPreScreenMarkdown(results), "utf8");

  console.info(`\nResults written to:`);
  console.info(`  JSON: ${jsonPath}`);
  console.info(`  Markdown: ${mdPath}`);

  const greenlit = results.filter((r) => r.decision === "greenlight");
  const deprioritized = results.filter((r) => r.decision === "deprioritize");
  console.info(
    `\n${String(greenlit.length)} greenlit, ${String(deprioritized.length)} deprioritized`,
  );
}
