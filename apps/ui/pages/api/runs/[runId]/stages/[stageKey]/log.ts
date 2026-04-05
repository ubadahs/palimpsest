import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "citation-fidelity/ui-contract";

import { getLogTail } from "@/lib/run-queries";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

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
    response.status(200).json({
      content: getLogTail(runId, stageKey),
    });
  } catch (error) {
    handleApiError(response, error);
  }
}
