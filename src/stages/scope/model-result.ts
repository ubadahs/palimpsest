import { z } from "zod";

import {
  scopeFailureCodeSchema,
  scopeFatalFailureCodeSchema,
} from "../../contract/artifacts/scope.js";
import { modelExecutionSchema } from "../../contract/model-execution.js";
import { createBoundaryParser } from "../../shared/boundary.js";

export class ScopeBoundaryError extends Error {
  override readonly name = "ScopeBoundaryError";
}

export class ScopeFatalError extends Error {
  override readonly name = "ScopeFatalError";

  constructor(
    readonly failureCode: z.infer<typeof scopeFatalFailureCodeSchema>,
    message: string,
  ) {
    super(message);
  }
}

export const parseScopeBoundary = createBoundaryParser(ScopeBoundaryError);

export const scopeModelResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("completed"),
        rawOutput: z.unknown(),
        execution: modelExecutionSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("failed"),
        reasonCode: scopeFailureCodeSchema,
        reason: z.string().min(1),
        execution: modelExecutionSchema,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.status === "completed" &&
      !Object.prototype.hasOwnProperty.call(result, "rawOutput")
    ) {
      context.addIssue({
        code: "custom",
        path: ["rawOutput"],
        message: "Completed Scope call requires the exact parsed model output",
      });
    }
  });

export function throwIfFatal(input: {
  reasonCode?: z.infer<typeof scopeFailureCodeSchema> | undefined;
  reason?: string | undefined;
}): void {
  const parsed = scopeFatalFailureCodeSchema.safeParse(input.reasonCode);
  if (parsed.success) {
    throw new ScopeFatalError(parsed.data, input.reason ?? parsed.data);
  }
}
