import { randomUUID } from "node:crypto";

import type { NextApiRequest, NextApiResponse } from "next";
import {
  analysisRunConfigSchema,
  analysisRunConfigObjectSchema,
  stageKeySchema,
} from "palimpsest/ui-contract";
import { z } from "zod";

import { createRun, getDashboardData } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError } from "@/lib/api-route";

const createRunSchema = z.object({
  seedDoi: z.string().min(1),
  trackedClaim: z.string().min(1).optional(),
  targetStage: stageKeySchema.default("adjudicate"),
  config: analysisRunConfigObjectSchema.partial().optional(),
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
      ...(payload.trackedClaim ? { trackedClaim: payload.trackedClaim } : {}),
      targetStage: payload.targetStage,
      config: analysisRunConfigSchema.parse({
        stopAfterStage: payload.targetStage,
        forceRefresh: false,
        discoverStrategy: "attribution_first",
        discoverModel: "claude-opus-4-6",
        discoverTopN: 5,
        discoverRank: true,
        discoverProbeBudget: 20,
        discoverShortlistCap: 10,
        screenGroundingModel: "claude-opus-4-6",
        screenFilterModel: "claude-haiku-4-5",
        screenFilterConcurrency: 10,
        evidenceLlmRerank: true,
        evidenceRerankModel: "claude-haiku-4-5",
        evidenceRerankTopN: 5,
        curateTargetSize: 40,
        adjudicateModel: "claude-opus-4-6",
        adjudicateThinking: true,
        familyConcurrency: 3,
        ...payload.config,
      }),
    });
    response.status(201).json(detail);
  } catch (error) {
    handleApiError(response, error);
  }
}
