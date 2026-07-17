import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  reportArtifactSchema,
  type ReportArtifact,
} from "../contract/lean-artifacts.js";
import { renderCanonicalReportMarkdown } from "../reporting/canonical-report-markdown.js";
import { loadJsonArtifact, writeJsonArtifact } from "../shared/artifact-io.js";

const CANONICAL_REPORT_ARTIFACT_LABEL = "canonical Report";

export type CanonicalReportWriteResult = {
  jsonPath: string;
  markdownPath: string;
  artifact: ReportArtifact;
  markdown: string;
};

/**
 * Validate/build JSON first, write it, then render Markdown from that exact
 * parsed object. Markdown-only mutation is impossible through this API.
 */
export function writeCanonicalReportArtifacts(
  jsonPath: string,
  markdownPath: string,
  artifactInput: ReportArtifact,
): CanonicalReportWriteResult {
  if (resolve(jsonPath) === resolve(markdownPath)) {
    throw new Error(
      "Canonical Report JSON and Markdown paths must resolve to different files",
    );
  }
  const artifact = reportArtifactSchema.parse(artifactInput);
  writeJsonArtifact(jsonPath, artifact);
  const parsedFromDisk = loadCanonicalReportArtifact(jsonPath);
  const markdown = renderCanonicalReportMarkdown(parsedFromDisk);
  writeFileSync(markdownPath, markdown, "utf8");
  return {
    jsonPath,
    markdownPath,
    artifact: parsedFromDisk,
    markdown,
  };
}

export function loadCanonicalReportArtifact(
  artifactPath: string,
): ReportArtifact {
  return loadJsonArtifact(
    artifactPath,
    reportArtifactSchema,
    CANONICAL_REPORT_ARTIFACT_LABEL,
  );
}
