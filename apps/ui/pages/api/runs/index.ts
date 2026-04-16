import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import type { NextApiRequest, NextApiResponse } from "next";
import {
  analysisRunConfigSchema,
  analysisRunConfigObjectSchema,
  stageKeySchema,
} from "palimpsest/contract";
import { z } from "zod";

import { createRun, getDashboardData } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError } from "@/lib/api-route";
import { ensureRunDirectories, getSeedPdfPath } from "@/lib/run-files";

const createRunSchema = z.object({
  seedDoi: z.string().min(1),
  trackedClaim: z.string().min(1).optional(),
  targetStage: stageKeySchema.default("adjudicate"),
  config: analysisRunConfigObjectSchema.partial().optional(),
  /** Base64-encoded PDF of the seed paper (bypasses open-access lookup). */
  seedPdfBase64: z.string().min(1).optional(),
});

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

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
      const payload = await getDashboardData();
      response.status(200).json(payload);
      return;
    }

    const payload = createRunSchema.parse(request.body);
    const runId = randomUUID();

    // If a seed PDF was uploaded, persist it and inject the path into config.
    let seedPdfConfig: { seedPdfPath: string } | Record<string, never> = {};
    if (payload.seedPdfBase64) {
      ensureRunDirectories(runId);
      const pdfPath = getSeedPdfPath(runId);
      writeFileSync(pdfPath, Buffer.from(payload.seedPdfBase64, "base64"));
      seedPdfConfig = { seedPdfPath: pdfPath };
    }

    const detail = createRun({
      id: runId,
      seedDoi: payload.seedDoi,
      ...(payload.trackedClaim ? { trackedClaim: payload.trackedClaim } : {}),
      targetStage: payload.targetStage,
      config: analysisRunConfigSchema.parse({
        stopAfterStage: payload.targetStage,
        ...payload.config,
        ...seedPdfConfig,
      }),
    });
    response.status(201).json(detail);
  } catch (error) {
    handleApiError(response, error);
  }
}
