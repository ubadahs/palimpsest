import { describe, expect, it } from "vitest";

import {
  adjudicateModelExecutionSchema,
  discoverModelExecutionSchema,
  evidenceRerankModelExecutionSchema,
  modelExecutionSchema,
  scopeGroundingModelExecutionSchema,
} from "../../src/contract/model-execution.js";
import { canonicalSha256 } from "../../src/shared/stable-identity.js";

const digest = canonicalSha256("fixture");
const artifact = {
  artifactId: `artifact_${digest}`,
  contentHash: digest,
  role: "fixture-model-response",
};

const sample = {
  kind: "model" as const,
  provider: "anthropic",
  model: "claude-fixture",
  promptId: "fixture-prompt",
  promptVersion: "v1",
  promptContentHash: digest,
  requestHash: digest,
  requestArtifact: artifact,
  responseArtifact: artifact,
};

describe("shared model execution schema", () => {
  it("is identical across Discover, Scope, Evidence, and Adjudicate aliases", () => {
    expect(discoverModelExecutionSchema).toBe(modelExecutionSchema);
    expect(scopeGroundingModelExecutionSchema).toBe(modelExecutionSchema);
    expect(evidenceRerankModelExecutionSchema).toBe(modelExecutionSchema);
    expect(adjudicateModelExecutionSchema).toBe(modelExecutionSchema);
  });

  it("requires kind model and rejects near-duplicate shapes missing kind", () => {
    expect(modelExecutionSchema.parse(sample)).toEqual(sample);
    const withoutKind = { ...sample };
    delete (withoutKind as { kind?: string }).kind;
    expect(modelExecutionSchema.safeParse(withoutKind).success).toBe(false);
  });
});
