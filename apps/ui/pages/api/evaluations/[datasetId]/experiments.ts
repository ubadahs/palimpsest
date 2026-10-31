import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  evaluationRoot,
  loadExperiment,
  loadTrials,
} from "palimpsest/evaluation/server";
import { allowMethods, handleApiError, readQueryParam } from "@/lib/api-route";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET"])) return;
  try {
    const datasetId = readQueryParam(request, "datasetId");
    const root = join(evaluationRoot(), "experiments");
    const experiments = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => {
            const experiment = loadExperiment(entry.name);
            if (experiment.datasetId !== datasetId) return [];
            const trials = loadTrials(entry.name);
            return [
              {
                experimentId: experiment.experimentId,
                createdAt: experiment.createdAt,
                config: experiment.config,
                success: trials.filter((trial) => trial.status === "success")
                  .length,
                planned: trials.length,
              },
            ];
          })
      : [];
    response.status(200).json(experiments);
  } catch (error) {
    handleApiError(response, error);
  }
}
