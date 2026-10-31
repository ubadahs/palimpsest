import type { NextApiRequest, NextApiResponse } from "next";
import {
  appendAnnotation,
  EvaluationConflictError,
} from "palimpsest/evaluation/server";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["POST"])) return;
  try {
    response
      .status(201)
      .json(
        appendAnnotation(readQueryParam(request, "datasetId"), request.body),
      );
  } catch (error) {
    if (error instanceof EvaluationConflictError) {
      response.status(409).json({ error: error.message });
      return;
    }
    handleApiError(response, error);
  }
}
