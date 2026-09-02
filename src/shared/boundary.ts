import type { z } from "zod";

/**
 * Builds the boundary parser a stage uses to validate everything crossing into
 * its domain layer. Each stage throws its own error class so a caller can tell
 * which boundary rejected the value; the message format is shared so the
 * failures read the same wherever they come from.
 */
export function createBoundaryParser(
  BoundaryError: new (message: string) => Error,
): <T>(schema: z.ZodType<T>, value: unknown, label: string) => T {
  return function parseBoundary<T>(
    schema: z.ZodType<T>,
    value: unknown,
    label: string,
  ): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "<root>";
    throw new BoundaryError(
      `Invalid ${label} at ${path}: ${issue?.message ?? parsed.error.message}`,
    );
  };
}
