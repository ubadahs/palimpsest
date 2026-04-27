import type {
  AttributedClaimExtractionRecord,
  HarvestedSeedMention,
  PaperHarvestSummary,
  ResolvedPaper,
} from "../../domain/types.js";
import type { LLMClient } from "../../integrations/llm-client.js";
import { pMap } from "../../shared/p-map.js";
import { extractAttributedClaims } from "../attributed-claim-extraction.js";
import type {
  MentionHarvestAdapters,
  MentionHarvestResult,
} from "../../retrieval/seed-mention-harvest.js";
import { harvestSeedMentions } from "../../retrieval/seed-mention-harvest.js";

export const DEFAULT_HARVEST_CONCURRENCY = 8;

export type HarvestAndExtractAttributionsParams = {
  seedPaper: ResolvedPaper;
  selectedPapers: ResolvedPaper[];
  mentionHarvest: MentionHarvestAdapters;
  llmClient: LLMClient;
  extractionModel?: string;
  extractionThinking?: boolean;
  harvestConcurrency: number;
  onPaperCompleted?: (completed: number, total: number, title: string) => void;
};

export type HarvestAndExtractAttributionsResult = {
  mentions: HarvestedSeedMention[];
  harvestSummaries: PaperHarvestSummary[];
  extractionRecords: AttributedClaimExtractionRecord[];
};

export async function harvestAndExtractAttributions(
  params: HarvestAndExtractAttributionsParams,
): Promise<HarvestAndExtractAttributionsResult> {
  const allMentions: HarvestedSeedMention[] = [];
  const allSummaries: PaperHarvestSummary[] = [];
  const allRecords: AttributedClaimExtractionRecord[] = [];
  const probeTotal = params.selectedPapers.length;
  let harvestCompleted = 0;

  const harvestChunks = await pMap(
    params.selectedPapers,
    async (citingPaper) => {
      const harvest: MentionHarvestResult = await harvestSeedMentions(
        citingPaper,
        params.seedPaper,
        params.mentionHarvest,
      );

      let records: AttributedClaimExtractionRecord[] = [];
      if (harvest.outcome === "success" && harvest.mentions.length > 0) {
        records = await extractAttributedClaims({
          seedPaper: params.seedPaper,
          citingPaperTitle: citingPaper.title,
          mentions: harvest.mentions,
          client: params.llmClient,
          options: {
            ...(params.extractionModel
              ? { model: params.extractionModel }
              : {}),
            useThinking: params.extractionThinking ?? false,
            enableExactCache: true,
          },
        });
      }

      harvestCompleted += 1;
      params.onPaperCompleted?.(
        harvestCompleted,
        probeTotal,
        citingPaper.title,
      );

      return { harvest, records };
    },
    { concurrency: params.harvestConcurrency },
  );

  for (const { harvest, records } of harvestChunks) {
    allSummaries.push(harvest.summary);
    if (harvest.outcome !== "success" || harvest.mentions.length === 0) {
      continue;
    }
    allMentions.push(...harvest.mentions);
    allRecords.push(...records);
  }

  return {
    mentions: allMentions,
    harvestSummaries: allSummaries,
    extractionRecords: allRecords,
  };
}
