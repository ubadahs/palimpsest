import type { NextApiRequest, NextApiResponse } from "next";
import { listDatasets } from "palimpsest/evaluation/server";
import { allowMethods, handleApiError } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET"])) return;
  try {
    response.status(200).json(
      listDatasets().map((dataset) => ({
        datasetId: dataset.datasetId,
        name: dataset.name,
        sources: dataset.sources,
        counts: Object.fromEntries(
          ["role", "rerank", "span", "adjudication"].map((task) => [
            task,
            dataset.cases.filter((item) => item.task === task).length,
          ]),
        ),
      })),
    );
  } catch (error) {
    handleApiError(response, error);
  }
}
