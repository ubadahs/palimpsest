import type { ResolvedPaper } from "../domain/types.js";
import type { ParsedPaperMaterializeResult } from "../retrieval/parsed-paper.js";

export type SeedClaimGroundingAdapters = {
  materializeSeedPaper: (
    paper: ResolvedPaper,
  ) => Promise<ParsedPaperMaterializeResult>;
};
