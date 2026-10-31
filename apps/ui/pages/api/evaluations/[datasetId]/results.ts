import type { NextApiRequest, NextApiResponse } from "next";
import { revealExperimentResults } from "palimpsest/evaluation/server";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["POST"])) return;
  try {
    const body = request.body as { experimentId?: unknown; reviewer?: unknown };
    if (
      typeof body.experimentId !== "string" ||
      typeof body.reviewer !== "string"
    )
      throw new Error("Experiment and reviewer are required");
    response
      .status(200)
      .json(
        revealExperimentResults(
          readQueryParam(request, "datasetId"),
          body.experimentId,
          body.reviewer,
        ),
      );
  } catch (error) {
    handleApiError(response, error);
  }
}
