import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "palimpsest/contract";
import { z } from "zod";

import { startRun } from "@/lib/run-supervisor";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export const startRunSchema = z
  .object({
    targetStage: stageKeySchema.optional(),
  })
  .strict();

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["POST"])) {
    return;
  }

  try {
    const payload = startRunSchema.parse(request.body ?? {});
    await startRun(readQueryParam(request, "runId"), payload.targetStage);
    response.status(200).json({ ok: true });
  } catch (error) {
    handleApiError(response, error);
  }
}
