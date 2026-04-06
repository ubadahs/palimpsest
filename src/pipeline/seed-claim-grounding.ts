import type { ResolvedPaper, Result } from "../domain/types.js";
import type { ParsedPaperMaterialized } from "../retrieval/parsed-paper.js";

export type SeedClaimGroundingAdapters = {
  materializeSeedPaper: (
    paper: ResolvedPaper,
  ) => Promise<Result<ParsedPaperMaterialized>>;
};
