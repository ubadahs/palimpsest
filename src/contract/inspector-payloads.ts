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
    {
      interpretationStatus: ReportArtifact["payload"]["interpretationStatus"];
      funnel: ReportArtifact["payload"]["funnel"];
      rates: ReportArtifact["payload"]["rates"];
    }
  > & { markdownPath?: string };
};

export type StageInspectorPayload<K extends StageKey = StageKey> =
  StageInspectorPayloadMap[K];
