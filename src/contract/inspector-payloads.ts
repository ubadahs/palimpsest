import type {
  AdjudicateArtifact,
  DiscoverArtifact,
  EvidenceArtifact,
  PrepareArtifact,
  ReportArtifact,
  ScopeArtifact,
} from "./lean-artifacts.js";
import type { StageKey } from "./lean-stages.js";

export type StageArtifactMap = {
  discover: DiscoverArtifact;
  scope: ScopeArtifact;
  prepare: PrepareArtifact;
  evidence: EvidenceArtifact;
  adjudicate: AdjudicateArtifact;
  report: ReportArtifact;
};

type CanonicalInspectorPayload<
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
 * Lean, client-safe row for one Prepare × Evidence × Adjudicate record.
 * Joined from upstream artifacts using the report `recordTraces` spine.
 */
export type ReportInspectorRecordRow = {
  recordId: string;
  familyId: string;
  citationOccurrenceId: string;
  trackedClaim: string;
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
  adjudicationStatus:
    | "adjudicated"
    | "not_adjudicated"
    | "adjudication_failed"
    | "invalid_output";
  verdict?: "F" | "D" | "E" | "U";
  confidence?: string;
  /** What the citing paper asserts, in the adjudicator's words. */
  citingAssertion?: string;
  /** What the selected seed chunks actually say, in the adjudicator's words. */
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
 * Deterministic inspector view only — never mutates canonical Report JSON.
 */
export type MutationFamilyView = {
  familyId: string;
  seedId: string;
  trackedClaim: string;
  seedTitle: string;
  seedDoi?: string;
  groundingStatus?: string;
  verifiedSeedGroundingSpans: ReportInspectorGroundingSpan[];
  recordCount: number;
  /** Distinct citing-paper × claim units, from the canonical Report. */
  uniqueClaimUnits?: number;
  /** How Discover judged the member claims equivalent. */
  equivalenceMethod?: "model" | "exact_normalized_text";
  verdictCounts: MutationFamilyVerdictCounts;
  /** Chronological citing-paper restatements (year → title → recordId). */
  records: ReportInspectorRecordRow[];
};

export type ReportInspectorSummary = {
  interpretationStatus: ReportArtifact["payload"]["interpretationStatus"];
  interpretationWarning: ReportArtifact["payload"]["interpretationWarning"];
  method: ReportArtifact["payload"]["method"];
  lineage: ReportArtifact["payload"]["lineage"];
  funnel: ReportArtifact["payload"]["funnel"];
  rates: ReportArtifact["payload"]["rates"];
  decisionSummaries: ReportArtifact["payload"]["decisionSummaries"];
  records: ReportInspectorRecordRow[];
  families: MutationFamilyView[];
};

export type StageInspectorPayloadMap = {
  discover: CanonicalInspectorPayload<
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
  scope: CanonicalInspectorPayload<
    "scope",
    ScopeArtifact,
    {
      candidateDecisions: number;
      selectedCandidates: number;
      families: number;
      materializedSeeds: number;
    }
  >;
  prepare: CanonicalInspectorPayload<
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
  evidence: CanonicalInspectorPayload<
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
  adjudicate: CanonicalInspectorPayload<
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
  report: CanonicalInspectorPayload<
    "report",
    ReportArtifact,
    ReportInspectorSummary
  > & {
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
