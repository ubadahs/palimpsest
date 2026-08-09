import type { NextApiRequest, NextApiResponse } from "next";
import { HumanReviewConflictError } from "palimpsest/contract";

import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";
import { getReviewStateForRun } from "@/lib/human-review";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

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
    response.status(200).json(getReviewStateForRun(runId));
  } catch (error) {
    if (error instanceof HumanReviewConflictError) {
      response.status(409).json({
        error: error.message,
        code: error.code,
        details: error.details ?? null,
      });
      return;
    }
    handleApiError(response, error);
  }
}
