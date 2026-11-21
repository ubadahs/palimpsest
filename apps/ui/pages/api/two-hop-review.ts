import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

import { allowMethods } from "@/lib/api-route";
import { getRepoRoot } from "@/lib/root-path";
import {
  loadTwoHopReview,
  saveTwoHopReview,
  ReviewConflict,
  ReviewPacketMissing,
  UnknownReviewCase,
} from "@/lib/two-hop-review-store";
import { saveTwoHopReviewSchema } from "@/lib/two-hop-review-types";

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse,
): void {
  if (!allowMethods(request, response, ["GET", "PUT"])) return;
  response.setHeader("Cache-Control", "no-store");
  const directory = join(getRepoRoot(), "data", "two-hop-review");
  try {
    if (request.method === "GET") {
      response.status(200).json(loadTwoHopReview(directory));
      return;
    }
    const parsed = saveTwoHopReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid review submission.",
        details: parsed.error.issues,
      });
      return;
    }
    response.status(200).json(saveTwoHopReview(directory, parsed.data));
  } catch (error) {
    const status =
      error instanceof ReviewConflict
        ? 409
        : error instanceof ReviewPacketMissing ||
            error instanceof UnknownReviewCase
          ? 404
          : 500;
    response.status(status).json({
      error: error instanceof Error ? error.message : "Two-hop review failed.",
    });
  }
}
