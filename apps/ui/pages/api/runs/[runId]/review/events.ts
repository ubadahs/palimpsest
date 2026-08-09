import type { NextApiRequest, NextApiResponse } from "next";
import {
  appendHumanReviewRequestSchema,
  HumanReviewConflictError,
} from "palimpsest/contract";

import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";
import { appendReviewEventForRun } from "@/lib/human-review";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["POST"])) {
    return;
  }

  try {
    ensureRunSupervisorReady();
    const runId = readQueryParam(request, "runId");
    const parsed = appendHumanReviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid human review event payload",
        details: parsed.error.flatten(),
      });
      return;
    }

    const result = appendReviewEventForRun(runId, parsed.data);
    response.status(201).json(result);
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
