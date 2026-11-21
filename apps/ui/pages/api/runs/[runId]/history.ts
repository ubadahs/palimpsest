import type { NextApiRequest, NextApiResponse } from "next";
import { listCitationHistory, loadCitationHistory } from "palimpsest/history";

import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";
import type { CitationHistorySummary } from "@/lib/citation-history";
import { getRunRoot } from "@/lib/run-files";
import { getCompletedReportForHistory } from "@/lib/run-queries";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET"])) return;

  try {
    const runId = readQueryParam(request, "runId");
    const report = getCompletedReportForHistory(
      runId,
      readQueryParam(request, "report"),
    );
    const reportIdentity = {
      runId,
      artifactId: report.artifactId,
      contentHash: report.contentHash,
    };
    const runRoot = getRunRoot(runId);
    if (request.query.artifact !== undefined) {
      const artifact = loadCitationHistory(
        runRoot,
        reportIdentity,
        readQueryParam(request, "artifact"),
      );
      if (request.query.download === "1") {
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${artifact.artifactId}.json"`,
        );
      }
      response.status(200).json(artifact);
      return;
    }
    const histories: CitationHistorySummary[] = listCitationHistory(
      runRoot,
      reportIdentity,
    ).map((artifact) => ({
      artifactId: artifact.artifactId,
      pathCount: artifact.payload.paths.length,
      neighborhoodCount: artifact.payload.neighborhoods.length,
    }));
    response.status(200).json(histories);
  } catch (error) {
    handleApiError(response, error);
  }
}
