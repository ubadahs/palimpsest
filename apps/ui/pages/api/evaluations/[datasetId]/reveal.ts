import type { NextApiRequest, NextApiResponse } from "next";
import { revealCase } from "palimpsest/evaluation/server";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["POST"])) return;
  try {
    const body = request.body as { caseId?: unknown; reviewer?: unknown };
    if (typeof body.caseId !== "string" || typeof body.reviewer !== "string")
      throw new Error("Case and reviewer are required");
    response
      .status(200)
      .json(
        revealCase(
          readQueryParam(request, "datasetId"),
          body.caseId,
          body.reviewer,
        ),
      );
  } catch (error) {
    handleApiError(response, error);
  }
}
