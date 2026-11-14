import type {
  AdjudicateArtifact,
  DiscoverArtifact,
  EvidenceArtifact,
  PrepareArtifact,
  ReportArtifact,
  ScopeArtifact,
} from "./artifacts/index.js";
import type { StageKey } from "./stages.js";

export type StageArtifactMap = {
  discover: DiscoverArtifact;
  scope: ScopeArtifact;
  prepare: PrepareArtifact;
  evidence: EvidenceArtifact;
  adjudicate: AdjudicateArtifact;
  report: ReportArtifact;
};

type InspectorPayload<
  K extends StageKey,
  TArtifact extends StageArtifactMap[K],
  TSummary,
> = {
  stageKey: K;
  rawArtifact: TArtifact;
  summary: TSummary;
};

/** Display-only evidence passage for the report record browser. */
export type ReportInspectorEvidencePassage = {
  chunkId: string;
  text: string;
  sourceBlockKind: string;
  sourceSectionTitle?: string;
  pinned: boolean;
  modelCited: boolean;
};

/** A seed passage a whole-paper verdict quoted, verified against the seed text. */
export type ReportInspectorSeedQuote = {
  quote: string;
  blockKind: string;
  sectionTitle?: string;
};

/** Verified seed-side grounding span for mutation / review display. */
export type ReportInspectorGroundingSpan = {
  text: string;
  blockId: string;
  blockKind: string;
  sectionTitle?: string;
  charOffsetStart: number;
  charOffsetEnd: number;
};

/** Occurrence-local attributed claim used for citing-span review. */
export type ReportInspectorOccurrenceClaim = {
  claimRecordId: string;
  extractedClaimText: string;
  supportSpan?: {
    text: string;
    charOffsetStart: number;
    charOffsetEnd: number;
  };
};

/**
 * Client-safe row for one Prepare × Evidence × Adjudicate record.
 * Joined from upstream artifacts using the report `recordTraces` spine.
 */
export type ReportInspectorRecordRow = {
  recordId: string;
  familyId: string;
  citationOccurrenceId: string;
  familyClaim: string;
  evaluatedClaimText: string;
  seedId: string;
  seedTitle: string;
  seedDoi?: string;
  /** Provider-stable citing paper identity; part of the claim-unit key. */
  citingPaperId: string;
  citingPaperTitle: string;
  citingPaperDoi?: string;
  citingPaperYear?: number;
  seedRefLabel?: string;
  sectionTitle?: string;
  citationContext: string;
  /** Where the seed's citation marker sits in `citationContext`. */
  citationMarkerSpan?: { charOffsetStart: number; charOffsetEnd: number };
  classificationStatus: string;
  citationRole?: string;
  evaluationMode?: string;
  groundingStatus?: string;
  verifiedSeedGroundingSpans: ReportInspectorGroundingSpan[];
  occurrenceClaims: ReportInspectorOccurrenceClaim[];
  retrievalStatus: string;
  rerankStatus: string;
  rankingSource?: string;
  evidencePassages: ReportInspectorEvidencePassage[];
  /** Present when the adjudicator read the whole seed text. */
  seedQuotes?: ReportInspectorSeedQuote[];
  adjudicationStatus:
    | "adjudicated"
    | "not_adjudicated"
    | "adjudication_failed"
    | "invalid_output";
  verdict?: "F" | "D" | "E" | "U";
  confidence?: string;
  /** What the citing paper asserts, in the adjudicator's words. */
  citingAssertion?: string;
  /** What the seed actually says on the point, in the adjudicator's words. */
  sourceStatement?: string;
  /** Named dimensions that moved; non-empty only for D. */
  mutationKinds?: string[];
  direction?: "strengthened" | "weakened" | "shifted" | "none";
  rationale?: string;
  evidenceSufficiency?: "sufficient" | "limited";
  evidenceLimitation?: "figure_only_support";
  gateCode?: string;
  failureCode?: string;
  operationalReason?: string;
};

export type MutationFamilyVerdictCounts = {
  F: number;
  D: number;
  E: number;
  U: number;
  not_adjudicated: number;
  failed: number;
};

/**
 * Family-centered mutation projection for the Report Families tab.
 * Deterministic inspector view only — never mutates Report JSON.
 */
export type MutationFamilyView = {
  familyId: string;
  seedId: string;
  claim: string;
  seedTitle: string;
  seedDoi?: string;
  groundingStatus?: string;
  verifiedSeedGroundingSpans: ReportInspectorGroundingSpan[];
  recordCount: number;
  /** Distinct citing-paper × claim units, from the Report. */
  uniqueClaimUnits?: number;
  /** How Discover judged the member claims equivalent. */
  equivalenceMethod?: "model" | "blocked_model" | "exact_normalized_text";
  verdictCounts: MutationFamilyVerdictCounts;
  /**
   * Chronological citing-paper restatements (year → title → recordId), as ids
   * into `ReportInspectorSummary.records`. Rows are not repeated here: at
   * census scale a second copy of every row doubled the inspector payload.
   */
  recordIds: string[];
};

export type ReportInspectorSummary = {
  interpretationStatus: ReportArtifact["payload"]["interpretationStatus"];
  interpretationWarning: ReportArtifact["payload"]["interpretationWarning"];
  method: ReportArtifact["payload"]["method"];
  lineage: ReportArtifact["payload"]["lineage"];
  funnel: ReportArtifact["payload"]["funnel"];
  rates: ReportArtifact["payload"]["rates"];
  weightedRates: ReportArtifact["payload"]["weightedRates"];
  decisionSummaries: ReportArtifact["payload"]["decisionSummaries"];
  records: ReportInspectorRecordRow[];
  families: MutationFamilyView[];
  /** Per seed codebook theme and entry tables, straight from the Report. */
  seedCodebooks: ReportArtifact["payload"]["seedCodebooks"];
};

export type StageInspectorPayloadMap = {
  discover: InspectorPayload<
    "discover",
    DiscoverArtifact,
    {
      seeds: number;
      citingPaperObservations: number;
      citationOccurrences: number;
      attributedClaims: number;
      candidates: number;
      selectedForScope: number;
    }
  >;
  scope: InspectorPayload<
    "scope",
    ScopeArtifact,
    {
      candidateDecisions: number;
      selectedCandidates: number;
      families: number;
      materializedSeeds: number;
    }
  >;
  prepare: InspectorPayload<
    "prepare",
    PrepareArtifact,
    {
      families: number;
      records: number;
      classified: number;
      ambiguous: number;
      failed: number;
    }
  >;
  evidence: InspectorPayload<
    "evidence",
    EvidenceArtifact,
    {
      records: number;
      retrievalOutcomes: Record<string, number>;
      selections: number;
      bm25Runs: number;
      rerankRuns: number;
    }
  >;
  adjudicate: InspectorPayload<
    "adjudicate",
    AdjudicateArtifact,
    {
      records: number;
      adjudicated: number;
      F: number;
      D: number;
      E: number;
      U: number;
      notAdjudicated: number;
      adjudicationFailed: number;
      invalidOutput: number;
    }
  >;
  report: InspectorPayload<"report", ReportArtifact, ReportInspectorSummary> & {
    markdownPath?: string;
  };
};

export type StageInspectorPayload<K extends StageKey = StageKey> =
  StageInspectorPayloadMap[K];

export type BuildStageInspectorOptions = {
  markdownPath?: string;
  preparePath?: string;
  evidencePath?: string;
  adjudicatePath?: string;
};
