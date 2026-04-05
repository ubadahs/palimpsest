import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "citation-fidelity/ui-contract";

import { getArtifactContent } from "@/lib/run-queries";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

function contentTypeForKind(kind: string): string {
  if (kind === "primary" || kind === "manifest") {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["GET"])) {
    return;
  }

  try {
    const runId = readQueryParam(request, "runId");
    const stageKey = stageKeySchema.parse(readQueryParam(request, "stageKey"));
    const kind = readQueryParam(request, "kind");
    const artifact = getArtifactContent(runId, stageKey, kind);
    response.setHeader("content-type", contentTypeForKind(kind));
    response.setHeader("x-artifact-path", artifact.path);
    response.status(200).send(artifact.content);
  } catch (error) {
    handleApiError(response, error);
  }
}
