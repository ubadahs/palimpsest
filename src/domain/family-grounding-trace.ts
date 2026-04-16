import type { ClaimGrounding } from "./pre-screen.js";

/** Per-family grounding trace persisted in the grounding-trace sidecar. */
export type FamilyGroundingTrace = {
  familyId: string;
  canonicalTrackedClaim: string;
  grounding: ClaimGrounding;
  /** Present when an LLM grounding call ran; includes Anthropic cache token fields when reported. */
  llmUsage?: {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};
