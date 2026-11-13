import { expect } from "vitest";
import type { z } from "zod";

function issueMessages(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  return result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

export function expectRejected(
  schema: z.ZodType,
  value: unknown,
  message: RegExp | string,
  label?: string,
): void {
  const messages = issueMessages(schema, value);
  expect(
    messages,
    label ?? "schema accepted a value it should reject",
  ).toBeDefined();
  if (typeof message === "string") expect(messages, label).toContain(message);
  else expect(messages, label).toMatch(message);
}
