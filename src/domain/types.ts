import { z } from "zod";

import type { AuditabilityStatus } from "./taxonomy.js";
export type { AuditabilityStatus } from "./taxonomy.js";

// --- Edge classification (lives here to avoid domain ↔ attribution-signal cycle) ---

export type EdgeClassification = {
  isReview: boolean;
  isCommentary: boolean;
  isLetter: boolean;
  isBookChapter: boolean;
  isPreprint: boolean;
  isJournalArticle: boolean;
  isPrimaryLike: boolean;
  highReferenceCount: boolean;
};

// --- Generic result type for operations that can fail ---

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// --- Full-text access status (discriminated union) ---

export type FullTextAvailable = {
  status: "available";
  source: string;
};

export type FullTextAbstractOnly = {
  status: "abstract_only";
};

export type FullTextUnavailable = {
  status: "unavailable";
  reason: string;
};

export type FullTextStatus =
  | FullTextAvailable
  | FullTextAbstractOnly
  | FullTextUnavailable;

// --- Resolved paper metadata ---

export const paperSourceValues = [
  "openalex",
  "semantic_scholar",
  "manual",
] as const;

export type PaperSource = (typeof paperSourceValues)[number];

export type ResolvedPaper = {
  id: string;
  doi: string | undefined;
  title: string;
  authors: string[];
  abstract: string | undefined;
  source: PaperSource;
  openAccessUrl: string | undefined;
  fullTextStatus: FullTextStatus;
  paperType: string | undefined;
  referencedWorksCount: number | undefined;
  publicationYear: number | undefined;
};

// --- Pre-screen edge ---

export type PreScreenEdge = {
  citingPaperId: string;
  citedPaperId: string;
  auditabilityStatus: AuditabilityStatus;
  auditabilityReason: string;
  classification: EdgeClassification;
  paperType: string | undefined;
  referencedWorksCount: number | undefined;
};

// --- Citation population composition ---

export type PreScreenMetrics = {
  totalEdges: number;
  uniqueEdges: number;
  collapsedDuplicates: number;
  auditableStructuredEdges: number;
  auditablePdfEdges: number;
  partiallyAuditableEdges: number;
  notAuditableEdges: number;
  auditableCoverage: number;
  primaryLikeEdgeCount: number;
  primaryLikeEdgeRate: number;
  reviewEdgeCount: number;
  reviewEdgeRate: number;
  commentaryEdgeCount: number;
  commentaryEdgeRate: number;
  letterEdgeCount: number;
  letterEdgeRate: number;
  bookChapterEdgeCount: number;
  bookChapterEdgeRate: number;
  articleEdgeCount: number;
  articleEdgeRate: number;
  preprintEdgeCount: number;
  preprintEdgeRate: number;
};

// --- Duplicate group provenance ---

export type DuplicateGroup = {
  duplicateGroupId: string;
  keptRepresentativePaperId: string;
  collapsedFromPaperIds: string[];
  collapseReason: string;
};

// --- Family use profile tags ---

export const familyUseProfileValues = [
  "primary_empirical_heavy",
  "mixed_primary_review",
  "review_mediated",
  "duplicate_heavy",
  "small_family",
  "low_access",
] as const;

export type FamilyUseProfileTag = (typeof familyUseProfileValues)[number];

// --- M2 priority recommendation ---

export const m2PriorityValues = [
  "first",
  "later",
  "caution",
  "not_now",
] as const;

export type M2Priority = (typeof m2PriorityValues)[number];

// --- Pre-screen decision ---

export const preScreenDecisionValues = ["greenlight", "deprioritize"] as const;

export type PreScreenDecision = (typeof preScreenDecisionValues)[number];

// --- Claim family pre-screen result ---

export type ClaimFamilyPreScreen = {
  seed: SeedPaperInput;
  resolvedSeedPaper: ResolvedPaper | undefined;
  edges: PreScreenEdge[];
  resolvedPapers: Record<string, ResolvedPaper>;
  duplicateGroups: DuplicateGroup[];
  metrics: PreScreenMetrics;
  familyUseProfile: FamilyUseProfileTag[];
  m2Priority: M2Priority;
  decision: PreScreenDecision;
  decisionReason: string;
};

// --- Shortlist input (validated from user-provided JSON) ---

export const seedPaperInputSchema = z.object({
  doi: z.string().min(1),
  trackedClaim: z.string().min(1),
  notes: z.string().optional(),
});

export type SeedPaperInput = z.infer<typeof seedPaperInputSchema>;

export const shortlistInputSchema = z.object({
  seeds: z.array(seedPaperInputSchema).min(1),
});

export type ShortlistInput = z.infer<typeof shortlistInputSchema>;

// --- M2: Citation context extraction ---

export const extractionOutcomeValues = [
  "success_structured",
  "success_pdf",
  "skipped_not_auditable",
  "fail_http_403",
  "fail_pdf_parse_error",
  "fail_no_reference_match",
  "fail_ref_list_empty",
  "fail_ref_found_but_no_in_text_xref",
  "fail_unknown",
] as const;

export type ExtractionOutcome = (typeof extractionOutcomeValues)[number];

export const markerStyleValues = [
  "author_year",
  "numeric",
  "year_only",
  "unknown",
] as const;

export type MarkerStyle = (typeof markerStyleValues)[number];

export const contextTypeValues = [
  "bibliography_like",
  "methods_like",
  "narrative_like",
  "unknown",
] as const;

export type ContextType = (typeof contextTypeValues)[number];

export const confidenceValues = ["low", "medium", "high"] as const;

export type Confidence = (typeof confidenceValues)[number];

export const bundlePatternValues = [
  "parenthetical_group",
  "semicolon_separated",
  "single",
  "unknown",
] as const;

export type BundlePattern = (typeof bundlePatternValues)[number];

export type CitationMention = {
  mentionIndex: number;
  rawContext: string;
  citationMarker: string;
  sectionTitle: string | undefined;
  isDuplicate: boolean;
  contextLength: number;
  markerStyle: MarkerStyle;
  contextType: ContextType;
  confidence: Confidence;
  isBundledCitation: boolean;
  bundleSize: number;
  bundleRefIds: string[];
  bundlePattern: BundlePattern;
  provenance: {
    sourceType: "jats_xml" | "pdf_text";
    parser: string;
    refId: string | undefined;
    charOffsetStart: number | undefined;
    charOffsetEnd: number | undefined;
  };
};

export type EdgeExtractionResult = {
  citingPaperId: string;
  citedPaperId: string;
  citingPaperTitle: string;
  sourceType: "jats_xml" | "pdf_text" | "not_attempted";
  extractionOutcome: ExtractionOutcome;
  extractionSuccess: boolean;
  usableForGrounding: boolean | "unknown";
  rawMentionCount: number;
  deduplicatedMentionCount: number;
  mentions: CitationMention[];
  failureReason: string | undefined;
};

export type ExtractionSummary = {
  totalEdges: number;
  attemptedEdges: number;
  successfulEdgesRaw: number;
  successfulEdgesUsable: number;
  rawMentionCount: number;
  deduplicatedMentionCount: number;
  usableMentionCount: number;
  failureCountsByOutcome: Partial<Record<ExtractionOutcome, number>>;
};

export type FamilyExtractionResult = {
  seed: SeedPaperInput;
  resolvedSeedPaper: ResolvedPaper;
  edgeResults: EdgeExtractionResult[];
  summary: ExtractionSummary;
};

// --- M3: Citation function classification ---

// Layer 1: Extraction state (pipeline outcome, orthogonal to content)
export const extractionStateValues = [
  "extracted",
  "failed",
  "skipped",
] as const;

export type ExtractionState = (typeof extractionStateValues)[number];

// Layer 2: Citation role (what the local citation act is doing)
export const citationRoleValues = [
  "substantive_attribution",
  "background_context",
  "methods_materials",
  "acknowledgment_or_low_information",
  "unclear",
] as const;

export type CitationRole = (typeof citationRoleValues)[number];

// Layer 3: Transmission modifiers (orthogonal flags, not roles)
export type TransmissionModifiers = {
  isBundled: boolean;
  isReviewMediated: boolean;
};

// Evaluation mode (derived from role + modifiers)
export const evaluationModeValues = [
  "fidelity_specific_claim",
  "fidelity_background_framing",
  "fidelity_bundled_use",
  "fidelity_methods_use",
  "review_transmission",
  "skip_low_information",
  "manual_review_role_ambiguous",
  "manual_review_extraction_limited",
] as const;

export type EvaluationMode = (typeof evaluationModeValues)[number];

export const studyModeValues = [
  "substantive_only",
  "all_functions_census",
  "background_and_bundled_focus",
  "methods_focus",
  "review_transmission_focus",
] as const;

export type StudyMode = (typeof studyModeValues)[number];

export const cachePolicyValues = [
  "prefer_cache",
  "refresh_missing_only",
  "force_refresh",
] as const;

export type CachePolicy = (typeof cachePolicyValues)[number];

// --- Classified mention (extends CitationMention with role + modifiers) ---

export type ClassifiedMention = CitationMention & {
  citationRole: CitationRole;
  modifiers: TransmissionModifiers;
  classificationSignals: string[];
};

// --- Evaluation task: the core unit of analysis ---
// One task per citation-role cluster within an edge.
// An edge with 2 substantive mentions and 1 methods mention produces 2 tasks.

export type EvaluationTask = {
  taskId: string;
  evaluationMode: EvaluationMode;
  citationRole: CitationRole;
  modifiers: TransmissionModifiers;
  mentions: ClassifiedMention[];
  mentionCount: number;
};

// --- Edge evaluation packet (contains tasks, not a single dominant label) ---

export type EdgeEvaluationPacket = {
  packetId: string;
  studyMode: StudyMode;

  citingPaper: {
    id: string;
    doi: string | undefined;
    title: string;
    paperType: string | undefined;
  };
  citedPaper: {
    id: string;
    doi: string | undefined;
    title: string;
    authors: string[];
    publicationYear: number | undefined;
  };

  extractionState: ExtractionState;
  extractionOutcome: ExtractionOutcome;
  auditabilityStatus: AuditabilityStatus;
  sourceType: "jats_xml" | "pdf_text" | "not_attempted";
  extractionConfidence: Confidence;
  usableForGrounding: boolean | "unknown";
  failureReason: string | undefined;

  mentions: ClassifiedMention[];
  tasks: EvaluationTask[];
  rolesPresent: CitationRole[];

  isReviewMediated: boolean;
  requiresManualReview: boolean;

  usableMentionsCount: number;
  bundledMentionsCount: number;

  cachedPaperRef: string | undefined;

  provenance: {
    preScreenRunId: string | undefined;
    extractionRunId: string | undefined;
    classificationTimestamp: string;
  };
};

// --- Family classification result ---

export type ExtractionStateSummary = {
  totalEdges: number;
  extracted: number;
  failed: number;
  skipped: number;
  failureCountsByOutcome: Partial<Record<ExtractionOutcome, number>>;
};

export type LiteratureStructureSummary = {
  edgesWithMentions: number;
  totalMentions: number;
  totalTasks: number;
  countsByRole: Record<CitationRole, number>;
  countsByMode: Record<EvaluationMode, number>;
  bundledMentionCount: number;
  bundledMentionRate: number;
  reviewMediatedEdgeCount: number;
  reviewMediatedEdgeRate: number;
  manualReviewTaskCount: number;
};

export type ClassificationSummary = {
  extractionState: ExtractionStateSummary;
  literatureStructure: LiteratureStructureSummary;
};

export type FamilyClassificationResult = {
  seed: SeedPaperInput;
  resolvedSeedPaperTitle: string;
  studyMode: StudyMode;
  packets: EdgeEvaluationPacket[];
  summary: ClassificationSummary;
};

// --- Per-mode fidelity rubrics ---

export type RubricQuestion = {
  mode: EvaluationMode;
  question: string;
  verdictOptions: string[];
};

// --- Evidence retrieval ---

export type EvidenceSpan = {
  spanId: string;
  text: string;
  sectionTitle: string | undefined;
  matchMethod:
    | "keyword_overlap"
    | "entity_overlap"
    | "claim_term"
    | "section_title";
  relevanceScore: number;
  charOffsetStart: number | undefined;
  charOffsetEnd: number | undefined;
};

export type TaskWithEvidence = EvaluationTask & {
  rubricQuestion: string;
  citedPaperEvidenceSpans: EvidenceSpan[];
  evidenceRetrievalStatus:
    | "retrieved"
    | "no_fulltext"
    | "no_matches"
    | "not_attempted";
};

export type EdgeWithEvidence = {
  packetId: string;
  citingPaperTitle: string;
  citedPaperTitle: string;
  extractionState: ExtractionState;
  isReviewMediated: boolean;
  tasks: TaskWithEvidence[];
};

export type FamilyEvidenceResult = {
  seed: SeedPaperInput;
  resolvedSeedPaperTitle: string;
  studyMode: StudyMode;
  citedPaperFullTextAvailable: boolean;
  edges: EdgeWithEvidence[];
  summary: EvidenceSummary;
};

export type EvidenceSummary = {
  totalTasks: number;
  tasksWithEvidence: number;
  tasksNoFulltext: number;
  tasksNoMatches: number;
  totalEvidenceSpans: number;
  tasksByMode: Partial<Record<EvaluationMode, number>>;
};

// --- Adjudication types ---

export const adjudicationVerdictValues = [
  "supported",
  "partially_supported",
  "overstated_or_generalized",
  "not_supported",
  "cannot_determine",
] as const;

export type AdjudicationVerdict = (typeof adjudicationVerdictValues)[number];

export const retrievalQualityValues = ["high", "medium", "low"] as const;
export type RetrievalQuality = (typeof retrievalQualityValues)[number];

export type AdjudicationRecord = {
  recordId: string;
  taskId: string;
  evaluationMode: EvaluationMode;
  citationRole: CitationRole;
  modifiers: TransmissionModifiers;

  citingPaperTitle: string;
  citedPaperTitle: string;

  citingSpan: string;
  citingSpanSection: string | undefined;
  citingMarker: string;

  rubricQuestion: string;
  evidenceSpans: EvidenceSpan[];
  evidenceRetrievalStatus: TaskWithEvidence["evidenceRetrievalStatus"];

  verdict: AdjudicationVerdict | undefined;
  rationale: string | undefined;
  retrievalQuality: RetrievalQuality | undefined;
  judgeConfidence: Confidence | undefined;

  adjudicator: string | undefined;
  adjudicatedAt: string | undefined;
  excluded: boolean | undefined;
  excludeReason: string | undefined;
  telemetry: LLMCallTelemetry | undefined;
};

export type CalibrationSet = {
  seed: SeedPaperInput;
  resolvedSeedPaperTitle: string;
  studyMode: StudyMode;
  createdAt: string;
  targetSize: number;
  records: AdjudicationRecord[];
  samplingStrategy: {
    targetByMode: Partial<Record<EvaluationMode, number>>;
    oversampled: string[];
  };
  runTelemetry: RunTelemetry | undefined;
};

// --- LLM telemetry ---

export type LLMCallTelemetry = {
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  reasoningTokens: number | undefined;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  latencyMs: number;
  finishReason: string;
  timestamp: string;
};

export type RunTelemetry = {
  model: string;
  useExtendedThinking: boolean;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
  calls: LLMCallTelemetry[];
};

// --- Paper cache types ---

export type CachedPaper = {
  paperId: string;
  doi: string | undefined;
  openalexId: string | undefined;
  pmcid: string | undefined;
  title: string;
  authorsJson: string | undefined;
  accessStatus: string;
  rawFullText: string | undefined;
  fullTextFormat: string | undefined;
  fetchSourceUrl: string | undefined;
  fetchStatus: string;
  contentHash: string | undefined;
  fetchedAt: string;
  metadataJson: string | undefined;
};

export type ParsedPaperData = {
  paperId: string;
  parserVersion: string;
  sectionsJson: string | undefined;
  refsJson: string | undefined;
  chunksJson: string | undefined;
  parsedAt: string;
};

export type DerivedArtifact = {
  artifactId: string;
  paperId: string;
  artifactType: "candidate_claim" | "section_summary" | "chunk_embedding";
  generator: string;
  createdAt: string;
  sourceSpanIds: string[];
  confidence: Confidence;
  status: "provisional";
  content: string;
};
