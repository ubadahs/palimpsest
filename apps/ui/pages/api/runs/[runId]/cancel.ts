import type { NextApiRequest, NextApiResponse } from "next";

import { cancelRun } from "@/lib/run-supervisor";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["POST"])) {
    return;
  }

  try {
    cancelRun(readQueryParam(request, "runId"));
    response.status(200).json({ ok: true });
  } catch (error) {
    handleApiError(response, error);
  }
}
