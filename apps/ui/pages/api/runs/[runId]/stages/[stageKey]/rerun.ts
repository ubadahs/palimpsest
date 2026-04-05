import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "citation-fidelity/ui-contract";

import { rerunStage } from "@/lib/run-supervisor";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["POST"])) {
    return;
  }

  try {
    const runId = readQueryParam(request, "runId");
    const stageKey = stageKeySchema.parse(readQueryParam(request, "stageKey"));
    await rerunStage(runId, stageKey);
    response.status(200).json({ ok: true });
  } catch (error) {
    handleApiError(response, error);
  }
}
