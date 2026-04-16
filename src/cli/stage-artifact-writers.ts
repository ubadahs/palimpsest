import { writeFileSync } from "node:fs";
import { basename } from "node:path";

import type {
  AuditSample,
  ClaimDiscoveryResult,
  ClaimFamilyPreScreen,
  FamilyClassificationResult,
  FamilyEvidenceResult,
  FamilyExtractionResult,
  PreScreenGroundingTraceFile,
} from "../domain/types.js";
import type { AttributionDiscoveryResult } from "../pipeline/discovery-family-probe.js";
import {
  toAttributionDiscoveryMarkdown,
  toDiscoveryMarkdown,
} from "../reporting/discovery-report.js";
import {
  toAuditSampleJson,
  toAuditSampleMarkdown,
} from "../reporting/adjudication-report.js";
import { toAuditSampleSummaryMarkdown } from "../reporting/audit-sample-summary.js";
import {
  toClassificationJson,
  toClassificationMarkdown,
} from "../reporting/classification-report.js";
import {
  toM2InspectionArtifact,
  toM2Json,
  toM2Markdown,
} from "../reporting/extraction-report.js";
import {
  toEvidenceJson,
  toEvidenceMarkdown,
} from "../reporting/evidence-report.js";
import { toPreScreenMarkdown } from "../reporting/pre-screen-report.js";
import {
  writeArtifactManifest,
  writeJsonArtifact,
} from "../shared/artifact-io.js";
import type { StageKey } from "../contract/run-types.js";
import { getStageDefinition } from "../contract/stages.js";
import {
  resolveStageArtifactPaths,
  resolveStageExtraArtifactPath,
} from "./stage-output.js";

type ArtifactContentFormat = "json" | "json-string" | "text";

type PrimaryReportWriteOptions = {
  outputRoot: string;
  stageKey: StageKey;
  stamp: string;
  familyIndex?: number;
  primaryContent: unknown;
  primaryFormat: ArtifactContentFormat;
  reportContent: string;
  artifactType: string;
  generator: string;
  sourceArtifacts: string[];
  relatedArtifacts?: string[];
  model?: string;
};

type SidecarWriteOptions = {
  outputRoot: string;
  stageKey: StageKey;
  stamp: string;
  suffix: string;
  content: unknown;
  format: ArtifactContentFormat;
  familyIndex?: number;
  manifest?: {
    artifactType: string;
    generator: string;
    sourceArtifacts: string[];
    relatedArtifacts?: string[];
    model?: string;
  };
};

function writeArtifactFile(
  path: string,
  content: unknown,
  format: ArtifactContentFormat,
): void {
  if (format === "json") {
    writeJsonArtifact(path, content);
    return;
  }

  const text =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(path, text, "utf8");
}

function writePrimaryReportArtifacts(options: PrimaryReportWriteOptions): {
  primaryPath: string;
  reportPath: string;
  manifestPath: string;
} {
  const paths = resolveStageArtifactPaths(
    options.outputRoot,
    options.stageKey,
    options.stamp,
    options.familyIndex,
  );

  writeArtifactFile(
    paths.primaryPath,
    options.primaryContent,
    options.primaryFormat,
  );
  writeArtifactFile(paths.reportPath, options.reportContent, "text");

  const relatedArtifacts = [
    paths.reportPath,
    ...(options.relatedArtifacts ?? []),
  ];
  const manifestPath = writeArtifactManifest(paths.primaryPath, {
    artifactType: options.artifactType,
    generator: options.generator,
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts,
    ...(options.model ? { model: options.model } : {}),
  });

  return {
    primaryPath: paths.primaryPath,
    reportPath: paths.reportPath,
    manifestPath,
  };
}

function writeSidecarArtifact(options: SidecarWriteOptions): {
  path: string;
  manifestPath: string | undefined;
} {
  const path = resolveStageExtraArtifactPath(
    options.outputRoot,
    options.stageKey,
    options.stamp,
    options.suffix,
    options.familyIndex,
  );
  writeArtifactFile(path, options.content, options.format);

  const manifestPath = options.manifest
    ? writeArtifactManifest(path, {
        artifactType: options.manifest.artifactType,
        generator: options.manifest.generator,
        sourceArtifacts: options.manifest.sourceArtifacts,
        ...(options.manifest.relatedArtifacts
          ? { relatedArtifacts: options.manifest.relatedArtifacts }
          : {}),
        ...(options.manifest.model ? { model: options.manifest.model } : {}),
      })
    : undefined;

  return { path, manifestPath };
}

export function writeDiscoveryArtifacts(options: {
  outputRoot: string;
  stamp: string;
  results: ClaimDiscoveryResult[];
  seeds: Array<{
    doi: string;
    trackedClaim: string;
    notes?: string | undefined;
  }>;
  sourceArtifacts: string[];
}): {
  jsonPath: string;
  mdPath: string;
  shortlistPath: string;
  manifestPath: string;
} {
  const shortlistSuffix =
    getStageDefinition("discover").artifactGlobs.extraSuffixes[0]!;
  const shortlist = writeSidecarArtifact({
    outputRoot: options.outputRoot,
    stageKey: "discover",
    stamp: options.stamp,
    suffix: shortlistSuffix,
    content: { seeds: options.seeds },
    format: "json",
  });
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "discover",
    stamp: options.stamp,
    primaryContent: options.results,
    primaryFormat: "json",
    reportContent: toDiscoveryMarkdown(options.results),
    artifactType: "discovery-results",
    generator: "discover",
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts: [shortlist.path],
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    shortlistPath: shortlist.path,
    manifestPath: primary.manifestPath,
  };
}

export function writeAttributionDiscoveryArtifacts(options: {
  outputRoot: string;
  stamp: string;
  results: AttributionDiscoveryResult[];
  seeds: Array<{
    doi: string;
    trackedClaim: string;
    notes?: string | undefined;
  }>;
  sourceArtifacts: string[];
}): {
  jsonPath: string;
  mdPath: string;
  shortlistPath: string;
  manifestPath: string;
} {
  const write = (suffix: string, content: unknown) =>
    writeSidecarArtifact({
      outputRoot: options.outputRoot,
      stageKey: "discover",
      stamp: options.stamp,
      suffix,
      content,
      format: "json",
    });

  // Shortlist
  const shortlist = write("_discovery-shortlist.json", {
    seeds: options.seeds,
  });

  // Aggregate sidecars across all DOIs — each file contains data from every result.
  const neighborhoods = write(
    "_discovery-neighborhood.json",
    options.results.map((r) => r.neighborhood),
  );
  const probes = write(
    "_discovery-probe.json",
    options.results.map((r) => r.probeSelection),
  );
  const mentions = write(
    "_discovery-mentions.json",
    options.results.flatMap((r) => r.mentions),
  );
  const extractions = write(
    "_discovery-attributed-claims.json",
    options.results.flatMap((r) => r.extractionRecords),
  );
  const families = write(
    "_discovery-family-candidates.json",
    options.results.flatMap((r) => r.familyCandidates),
  );
  const groundingTrace = write(
    "_discovery-grounding-trace.json",
    options.results.flatMap((r) => r.groundingTraces),
  );

  const consolidations = options.results
    .map((r) => r.consolidation)
    .filter((c): c is NonNullable<typeof c> => c != null);
  const consolidationSidecar =
    consolidations.length > 0
      ? write("_family-consolidation.json", consolidations)
      : undefined;

  const sidecarPaths = [
    shortlist.path,
    neighborhoods.path,
    probes.path,
    mentions.path,
    extractions.path,
    families.path,
    groundingTrace.path,
    ...(consolidationSidecar ? [consolidationSidecar.path] : []),
  ];

  // Primary JSON: compact summary (not the full trace)
  const primaryContent = options.results.map((r) => ({
    doi: r.doi,
    resolvedPaper: r.resolvedPaper,
    neighborhood: {
      totalCitingPapers: r.neighborhood.totalCitingPapers,
      fullTextAvailableCount: r.neighborhood.fullTextAvailableCount,
    },
    probeSelection: {
      strategy: r.probeSelection.strategy,
      selectedCount: r.probeSelection.selectedCount,
      excludedCount: r.probeSelection.excludedCount,
    },
    mentionsHarvested: r.mentions.length,
    inScopeExtractions: r.extractionRecords.filter(
      (rec) => rec.inScopeEmpiricalAttribution,
    ).length,
    rawFamilyCandidateCount: r.extractionRecords.filter(
      (rec) => rec.inScopeEmpiricalAttribution,
    ).length,
    familyCandidateCount: r.familyCandidates.length,
    dedupeMergedCount:
      r.extractionRecords.filter((rec) => rec.inScopeEmpiricalAttribution)
        .length - r.familyCandidates.length,
    shortlistEntries: r.shortlistEntries,
    warnings: r.warnings,
  }));

  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "discover",
    stamp: options.stamp,
    primaryContent,
    primaryFormat: "json",
    reportContent: toAttributionDiscoveryMarkdown(options.results),
    artifactType: "discovery-results",
    generator: "discover-attribution-first",
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts: sidecarPaths,
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    shortlistPath: shortlist.path,
    manifestPath: primary.manifestPath,
  };
}

export function writeScreenArtifacts(options: {
  outputRoot: string;
  stamp: string;
  families: ClaimFamilyPreScreen[];
  groundingTrace: PreScreenGroundingTraceFile;
  sourceArtifacts: string[];
}): {
  jsonPath: string;
  mdPath: string;
  tracePath: string;
  manifestPath: string;
  traceManifestPath: string;
} {
  const traceSuffix =
    getStageDefinition("screen").artifactGlobs.extraSuffixes[0]!;
  const trace = writeSidecarArtifact({
    outputRoot: options.outputRoot,
    stageKey: "screen",
    stamp: options.stamp,
    suffix: traceSuffix,
    content: options.groundingTrace,
    format: "json",
  });
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "screen",
    stamp: options.stamp,
    primaryContent: options.families,
    primaryFormat: "json",
    reportContent: toPreScreenMarkdown(options.families, {
      groundingTraceFileName: basename(trace.path),
    }),
    artifactType: "pre-screen-results",
    generator: "pre-screen",
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts: [trace.path],
  });
  const traceManifestPath = writeArtifactManifest(trace.path, {
    artifactType: "pre-screen-grounding-trace",
    generator: "pre-screen",
    sourceArtifacts: [...options.sourceArtifacts, primary.primaryPath],
    relatedArtifacts: [primary.primaryPath, primary.reportPath],
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    tracePath: trace.path,
    manifestPath: primary.manifestPath,
    traceManifestPath,
  };
}

export function writeExtractionArtifacts(options: {
  outputRoot: string;
  stamp: string;
  result: FamilyExtractionResult;
  sourceArtifacts: string[];
  familyIndex?: number;
}): {
  jsonPath: string;
  mdPath: string;
  inspectionPath: string;
  manifestPath: string;
} {
  const inspectionSuffix =
    getStageDefinition("extract").artifactGlobs.extraSuffixes[0]!;
  const inspection = writeSidecarArtifact({
    outputRoot: options.outputRoot,
    stageKey: "extract",
    stamp: options.stamp,
    suffix: inspectionSuffix,
    content: toM2InspectionArtifact(options.result),
    format: "text",
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
  });
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "extract",
    stamp: options.stamp,
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
    primaryContent: toM2Json(options.result),
    primaryFormat: "json-string",
    reportContent: toM2Markdown(options.result),
    artifactType: "extraction-results",
    generator: "extract",
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts: [inspection.path],
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    inspectionPath: inspection.path,
    manifestPath: primary.manifestPath,
  };
}

export function writeClassificationArtifacts(options: {
  outputRoot: string;
  stamp: string;
  result: FamilyClassificationResult;
  sourceArtifacts: string[];
  familyIndex?: number;
}): {
  jsonPath: string;
  mdPath: string;
  manifestPath: string;
} {
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "classify",
    stamp: options.stamp,
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
    primaryContent: toClassificationJson(options.result),
    primaryFormat: "json-string",
    reportContent: toClassificationMarkdown(options.result),
    artifactType: "classification-results",
    generator: "classify",
    sourceArtifacts: options.sourceArtifacts,
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    manifestPath: primary.manifestPath,
  };
}

export function writeEvidenceArtifacts(options: {
  outputRoot: string;
  stamp: string;
  result: FamilyEvidenceResult;
  sourceArtifacts: string[];
  familyIndex?: number;
}): {
  jsonPath: string;
  mdPath: string;
  manifestPath: string;
} {
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "evidence",
    stamp: options.stamp,
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
    primaryContent: toEvidenceJson(options.result),
    primaryFormat: "json-string",
    reportContent: toEvidenceMarkdown(options.result),
    artifactType: "evidence-results",
    generator: "evidence",
    sourceArtifacts: options.sourceArtifacts,
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    manifestPath: primary.manifestPath,
  };
}

export function writeAuditSampleArtifacts(options: {
  outputRoot: string;
  stamp: string;
  result: AuditSample;
  sourceArtifacts: string[];
  familyIndex?: number;
}): {
  jsonPath: string;
  mdPath: string;
  manifestPath: string;
} {
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "curate",
    stamp: options.stamp,
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
    primaryContent: toAuditSampleJson(options.result),
    primaryFormat: "json-string",
    reportContent: toAuditSampleMarkdown(options.result),
    artifactType: "audit-sample",
    generator: "curate",
    sourceArtifacts: options.sourceArtifacts,
  });

  return {
    jsonPath: primary.primaryPath,
    mdPath: primary.reportPath,
    manifestPath: primary.manifestPath,
  };
}

export function writeAdjudicationArtifacts(options: {
  outputRoot: string;
  stamp: string;
  result: AuditSample;
  sourceArtifacts: string[];
  model: string;
  familyIndex?: number;
  agreementMarkdown?: string;
}): {
  jsonPath: string;
  summaryPath: string;
  agreementPath: string | undefined;
  manifestPath: string;
} {
  const agreementSuffix =
    getStageDefinition("adjudicate").artifactGlobs.extraSuffixes[0]!;
  const agreement = options.agreementMarkdown
    ? writeSidecarArtifact({
        outputRoot: options.outputRoot,
        stageKey: "adjudicate",
        stamp: options.stamp,
        suffix: agreementSuffix,
        content: options.agreementMarkdown,
        format: "text",
        ...(options.familyIndex != null
          ? { familyIndex: options.familyIndex }
          : {}),
      })
    : undefined;
  const primary = writePrimaryReportArtifacts({
    outputRoot: options.outputRoot,
    stageKey: "adjudicate",
    stamp: options.stamp,
    ...(options.familyIndex != null
      ? { familyIndex: options.familyIndex }
      : {}),
    primaryContent: toAuditSampleJson(options.result),
    primaryFormat: "json-string",
    reportContent: toAuditSampleSummaryMarkdown(options.result),
    artifactType: "llm-audit-sample",
    generator: "adjudicate",
    sourceArtifacts: options.sourceArtifacts,
    relatedArtifacts: agreement ? [agreement.path] : [],
    model: options.model,
  });

  return {
    jsonPath: primary.primaryPath,
    summaryPath: primary.reportPath,
    agreementPath: agreement?.path,
    manifestPath: primary.manifestPath,
  };
}
