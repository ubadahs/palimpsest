import type { NextApiRequest, NextApiResponse } from "next";

import { getDashboardData } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";
import { allowMethods, handleApiError } from "@/lib/api-route";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): Promise<void> {
  if (!allowMethods(request, response, ["GET"])) {
    return;
  }

  try {
    ensureRunSupervisorReady();
    const { health } = await getDashboardData();
    response.status(200).json(health);
  } catch (error) {
    handleApiError(response, error);
  }
}
