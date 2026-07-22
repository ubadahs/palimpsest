import type {
  AdjudicateArtifact,
  DiscoverArtifact,
  EvidenceArtifact,
  PrepareArtifact,
  ReportArtifact,
  ScopeArtifact,
} from "./lean-artifacts.js";
import type { StageKey } from "./run-types.js";

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
  comparison?: string;
  rationale?: string;
  gateCode?: string;
  failureCode?: string;
  operationalReason?: string;
};

export type ReportInspectorSummary = {
  interpretationStatus: ReportArtifact["payload"]["interpretationStatus"];
  interpretationWarning: ReportArtifact["payload"]["interpretationWarning"];
  method: ReportArtifact["payload"]["method"];
  lineage: ReportArtifact["payload"]["lineage"];
  funnel: ReportArtifact["payload"]["funnel"];
  rates: ReportArtifact["payload"]["rates"];
  decisionSummaries: ReportArtifact["payload"]["decisionSummaries"];
  exclusionSummaries: ReportArtifact["payload"]["exclusionSummaries"];
  records: ReportInspectorRecordRow[];
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
