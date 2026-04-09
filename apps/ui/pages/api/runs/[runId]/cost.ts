import type { NextApiRequest, NextApiResponse } from "next";

import { getRunCostSummary } from "@/lib/run-queries";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET"])) {
    return;
  }

  try {
    const runId = readQueryParam(request, "runId");
    const cost = getRunCostSummary(runId);
    response.status(200).json(cost ?? null);
  } catch (error) {
    handleApiError(response, error);
  }
}
