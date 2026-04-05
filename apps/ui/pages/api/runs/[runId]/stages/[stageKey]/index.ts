import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "citation-fidelity/ui-contract";

import { getStageDetailOrThrow } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["GET"])) {
    return;
  }

  try {
    ensureRunSupervisorReady();
    const runId = readQueryParam(request, "runId");
    const stageKey = stageKeySchema.parse(readQueryParam(request, "stageKey"));
    response.status(200).json(getStageDetailOrThrow(runId, stageKey));
  } catch (error) {
    handleApiError(response, error);
  }
}
