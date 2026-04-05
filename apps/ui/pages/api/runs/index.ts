import { randomUUID } from "node:crypto";

import type { NextApiRequest, NextApiResponse } from "next";
import { analysisRunConfigSchema, stageKeySchema } from "citation-fidelity/ui-contract";
import { z } from "zod";

import { createRun, getDashboardData } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError } from "@/lib/api-route";

const createRunSchema = z.object({
  seedDoi: z.string().min(1),
  trackedClaim: z.string().min(1),
  targetStage: stageKeySchema.default("m6-llm-judge"),
  config: analysisRunConfigSchema.partial().optional(),
});

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["GET", "POST"])) {
    return;
  }

  try {
    ensureRunSupervisorReady();

    if (request.method === "GET") {
      const { runs } = await getDashboardData();
      response.status(200).json(runs);
      return;
    }

    const payload = createRunSchema.parse(request.body);
    const detail = createRun({
      id: randomUUID(),
      seedDoi: payload.seedDoi,
      trackedClaim: payload.trackedClaim,
      targetStage: payload.targetStage,
      config: analysisRunConfigSchema.parse({
        stopAfterStage: payload.targetStage,
        forceRefresh: false,
        m5TargetSize: 40,
        m6Model: "claude-opus-4-6",
        m6Thinking: false,
        ...payload.config,
      }),
    });
    response.status(201).json(detail);
  } catch (error) {
    handleApiError(response, error);
  }
}
