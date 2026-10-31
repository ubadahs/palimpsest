import type { NextApiRequest, NextApiResponse } from "next";
import { blindDatasetView } from "palimpsest/evaluation/server";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET"])) return;
  try {
    response
      .status(200)
      .json(blindDatasetView(readQueryParam(request, "datasetId")));
  } catch (error) {
    handleApiError(response, error);
  }
}
