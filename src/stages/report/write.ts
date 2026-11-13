import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadArtifact, writeArtifact } from "../../contract/selectors.js";
import type { ReportArtifact } from "../../contract/artifacts/index.js";
import { renderReportMarkdown } from "./markdown.js";

export type ReportWriteResult = {
  jsonPath: string;
  markdownPath: string;
  artifact: ReportArtifact;
  markdown: string;
};

/**
 * Validate/build JSON first, write it, then render Markdown from that exact
 * parsed object. Markdown-only mutation is impossible through this API.
 */
export function writeReportArtifacts(
  jsonPath: string,
  markdownPath: string,
  artifactInput: ReportArtifact,
): ReportWriteResult {
  if (resolve(jsonPath) === resolve(markdownPath)) {
    throw new Error(
      "Report JSON and Markdown paths must resolve to different files",
    );
  }
  writeArtifact("report", jsonPath, artifactInput);
  const parsedFromDisk = loadArtifact("report", jsonPath);
  const markdown = renderReportMarkdown(parsedFromDisk);
  writeFileSync(markdownPath, markdown, "utf8");
  return {
    jsonPath,
    markdownPath,
    artifact: parsedFromDisk,
    markdown,
  };
}
