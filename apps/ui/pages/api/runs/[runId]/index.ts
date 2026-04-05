import type { NextApiRequest, NextApiResponse } from "next";

import { getRunDetailOrThrow } from "@/lib/run-queries";
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
    response.status(200).json(getRunDetailOrThrow(runId));
  } catch (error) {
    handleApiError(response, error);
  }
}
