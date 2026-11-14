import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { StageArtifactMap } from "../contract/inspector-payloads.js";
import {
  buildReportInspectorRecords,
  loadArtifact,
} from "../contract/selectors.js";
import type { StageKey } from "../contract/stages.js";
import { verifyReportAncestors } from "../stages/report/run.js";

type AncestorStage =
  | "discover"
  | "scope"
  | "prepare"
  | "evidence"
  | "adjudicate";
/** A finished report and every stage artifact it was built from. */
export type ReportChain = { [K in StageKey]: StageArtifactMap[K] };

function loadAncestor<K extends AncestorStage>(
  runRoot: string,
  stage: K,
  reference: { artifactId: string; contentHash: string },
): StageArtifactMap[K] {
  const folder = readdirSync(runRoot, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.endsWith(`-${stage}`),
  );
  if (!folder)
    throw new Error(`Missing ${stage} stage directory in ${runRoot}`);
  const matches = readdirSync(join(runRoot, folder.name)).filter(
    (name) =>
      name.endsWith(`_${stage}.json`) && name.includes(reference.artifactId),
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one ${stage} artifact matching ${reference.artifactId}`,
    );
  const artifact = loadArtifact(stage, join(runRoot, folder.name, matches[0]!));
  if (
    artifact.artifactId !== reference.artifactId ||
    artifact.contentHash !== reference.contentHash
  )
    throw new Error(`${stage} lineage mismatch`);
  return artifact;
}

/**
 * Load a report and the exact ancestors its lineage names, verifying each
 * identity hash and that the report's record spine joins completely.
 */
export function loadReportChain(reportPath: string): {
  chain: ReportChain;
  runRoot: string;
} {
  const full = resolve(reportPath);
  const report = loadArtifact("report", full);
  const runRoot = dirname(dirname(full));
  const lineage = report.payload.lineage;
  if (report.runId !== lineage.runId)
    throw new Error("Report run identity mismatch");
  const discover = loadAncestor(runRoot, "discover", lineage.discoverArtifact);
  const scope = loadAncestor(runRoot, "scope", lineage.scopeArtifact);
  const prepare = loadAncestor(runRoot, "prepare", lineage.prepareArtifact);
  const evidence = loadAncestor(runRoot, "evidence", lineage.evidenceArtifact);
  const adjudicate = loadAncestor(
    runRoot,
    "adjudicate",
    lineage.adjudicateArtifact,
  );
  verifyReportAncestors({
    discoverArtifact: discover,
    scopeArtifact: scope,
    prepareArtifact: prepare,
    evidenceArtifact: evidence,
    adjudicateArtifact: adjudicate,
  });
  buildReportInspectorRecords({ report, prepare, evidence, adjudicate });
  if (report.payload.recordTraces.length !== prepare.payload.records.length)
    throw new Error("Report record spine is incomplete");
  return {
    chain: { discover, scope, prepare, evidence, adjudicate, report },
    runRoot,
  };
}
