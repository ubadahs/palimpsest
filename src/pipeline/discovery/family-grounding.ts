import type {
  AttributedClaimFamilyCandidate,
  ClaimGrounding,
  FamilyCandidateSeedGrounding,
  ParsedPaperDocument,
  ResolvedPaper,
} from "../../domain/types.js";
import type { FamilyGroundingTrace } from "../../domain/family-grounding-trace.js";
import { pMap } from "../../shared/p-map.js";
import {
  buildSeedFullTextForLlm,
  runLlmFullDocumentClaimGrounding,
  type SeedClaimLlmGroundingOptions,
} from "../seed-claim-grounding-llm.js";

export const DEFAULT_GROUNDING_CONCURRENCY = 5;

function toSeedGrounding(
  grounding: ClaimGrounding,
): FamilyCandidateSeedGrounding {
  const spanTexts = grounding.supportSpans.map((s) => s.text);
  return {
    status: grounding.status,
    normalizedClaim: grounding.normalizedClaim,
    supportSpanText: spanTexts.length > 0 ? spanTexts.join(" … ") : undefined,
    groundingDetail: grounding.detailReason,
  };
}

export type GroundFamiliesAgainstSeedParams = {
  doi: string;
  seedPaper: ResolvedPaper;
  seedParsedDocument: ParsedPaperDocument;
  families: AttributedClaimFamilyCandidate[];
  groundingOptions: SeedClaimLlmGroundingOptions;
  groundingConcurrency: number;
  onFamilyGrounded?: (completed: number, total: number, claim: string) => void;
};

export async function groundFamiliesAgainstSeed(
  params: GroundFamiliesAgainstSeedParams,
): Promise<FamilyGroundingTrace[]> {
  const manuscript = buildSeedFullTextForLlm(params.seedParsedDocument);
  if (manuscript.length === 0) {
    for (const fam of params.families) {
      fam.seedGrounding = {
        status: "no_seed_fulltext",
        supportSpanText: undefined,
        groundingDetail: "Parsed document has no text blocks",
      };
    }
    return [];
  }

  const groundTotal = params.families.length;
  let groundCompleted = 0;

  const traces = await pMap(
    params.families,
    async (fam) => {
      const { grounding, llmCall } = await runLlmFullDocumentClaimGrounding({
        seed: { doi: params.doi, trackedClaim: fam.canonicalTrackedClaim },
        seedPaper: params.seedPaper,
        parsedDocument: params.seedParsedDocument,
        options: params.groundingOptions,
      });
      fam.seedGrounding = toSeedGrounding(grounding);

      groundCompleted += 1;
      params.onFamilyGrounded?.(
        groundCompleted,
        groundTotal,
        fam.canonicalTrackedClaim,
      );

      return {
        familyId: fam.familyId,
        canonicalTrackedClaim: fam.canonicalTrackedClaim,
        grounding,
        ...(llmCall != null &&
        (llmCall.inputTokens != null ||
          typeof llmCall.cacheReadTokens === "number" ||
          typeof llmCall.cacheWriteTokens === "number")
          ? {
              llmUsage: {
                ...(llmCall.inputTokens != null
                  ? { inputTokens: llmCall.inputTokens }
                  : {}),
                ...(typeof llmCall.cacheReadTokens === "number"
                  ? { cacheReadTokens: llmCall.cacheReadTokens }
                  : {}),
                ...(typeof llmCall.cacheWriteTokens === "number"
                  ? { cacheWriteTokens: llmCall.cacheWriteTokens }
                  : {}),
              },
            }
          : {}),
      } satisfies FamilyGroundingTrace;
    },
    { concurrency: params.groundingConcurrency },
  );

  traces.sort((a, b) => a.familyId.localeCompare(b.familyId));
  return traces;
}
