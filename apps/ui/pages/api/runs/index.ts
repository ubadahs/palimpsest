import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";

import type { NextApiRequest, NextApiResponse } from "next";
import { analysisRunConfigSchema, stageKeySchema } from "palimpsest/contract";
import { z } from "zod";

import { createRun, getDashboardData } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError } from "@/lib/api-route";
import { ensureRunDirectories, getSeedPdfPath } from "@/lib/run-files";

function normalizeDoi(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

export const createRunSchema = z
  .object({
    /** Ordered nonempty seed DOI list. First DOI is the run tracking seed. */
    seedDois: z.array(z.string().min(1)).min(1),
    targetStage: stageKeySchema.default("report"),
    config: analysisRunConfigSchema.optional(),
    /** Base64-encoded PDF of the seed paper (single-DOI runs only). */
    seedPdfBase64: z.string().min(1).optional(),
  })
  .superRefine((payload, context) => {
    const normalized = payload.seedDois.map(normalizeDoi);
    if (normalized.some((doi) => doi.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["seedDois"],
        message: "seedDois must not contain blank DOI values.",
      });
    }
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: "custom",
        path: ["seedDois"],
        message: "seedDois must not contain duplicate normalized DOIs.",
      });
    }
    if (
      payload.seedDois.length > 1 &&
      (payload.seedPdfBase64 || payload.config?.scope.seedPdfPath)
    ) {
      context.addIssue({
        code: "custom",
        path: [
          payload.seedPdfBase64 ? "seedPdfBase64" : "config",
          ...(payload.seedPdfBase64 ? [] : ["scope", "seedPdfPath"]),
        ],
        message:
          "seed PDFs and scope.seedPdfPath are only valid for a single-DOI run.",
      });
    }
  });

export function buildCreateRunConfig(input: {
  requestedConfig: z.infer<typeof analysisRunConfigSchema>;
  targetStage: z.infer<typeof stageKeySchema>;
  seedPdfPath?: string;
}) {
  return analysisRunConfigSchema.parse({
    ...input.requestedConfig,
    stopAfterStage: input.targetStage,
    scope: {
      ...input.requestedConfig.scope,
      ...(input.seedPdfPath ? { seedPdfPath: input.seedPdfPath } : {}),
    },
  });
}

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
    const seedDois = payload.seedDois.map((doi) => doi.trim()) as [
      string,
      ...string[],
    ];
    const seedDoi = seedDois[0];
    const runId = randomUUID();

    let seedPdfPath: string | undefined;
    if (payload.seedPdfBase64) {
      ensureRunDirectories(runId);
      seedPdfPath = getSeedPdfPath(runId);
      writeFileSync(seedPdfPath, Buffer.from(payload.seedPdfBase64, "base64"));
    }

    try {
      const requestedConfig =
        payload.config ?? analysisRunConfigSchema.parse({});
      const detail = createRun({
        id: runId,
        seedDoi,
        seedDois,
        targetStage: payload.targetStage,
        config: buildCreateRunConfig({
          requestedConfig,
          targetStage: payload.targetStage,
          ...(seedPdfPath ? { seedPdfPath } : {}),
        }),
      });
      response.status(201).json(detail);
    } catch (error) {
      if (seedPdfPath) {
        try {
          unlinkSync(seedPdfPath);
        } catch {
          /* best-effort cleanup */
        }
      }
      throw error;
    }
  } catch (error) {
    handleApiError(response, error);
  }
}
