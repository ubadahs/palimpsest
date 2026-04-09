import type { NextApiRequest, NextApiResponse } from "next";
import { stageKeySchema } from "palimpsest/ui-contract";

import { getLogTail } from "@/lib/run-queries";
import {
  allowMethods,
  handleApiError,
  readOptionalFamilyIndex,
  readQueryParam,
} from "@/lib/api-route";

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
    const familyIndex = readOptionalFamilyIndex(request);
    response.status(200).json({
      content: getLogTail(runId, stageKey, familyIndex),
    });
  } catch (error) {
    handleApiError(response, error);
  }
}
