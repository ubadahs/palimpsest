import { z } from "zod";

import type {
  DiscoverAttributedClaimRecord,
  DiscoverCitationOccurrence,
  DiscoverClaimCandidate,
} from "./lean-artifacts.js";
import { METHODS_SECTION_PATTERNS } from "../domain/section-patterns.js";
import { canonicalSha256 } from "../shared/stable-identity.js";
import {
  CANDIDATE_SELECTION_POLICY_VERSION,
  type AdaptivePortfolioPolicy,
} from "./adaptive-portfolio-policy.js";

export {
  CANDIDATE_SELECTION_POLICY_VERSION,
  adaptivePortfolioPolicySchema,
  defaultAdaptivePortfolioPolicy,
  type AdaptivePortfolioPolicy,
} from "./adaptive-portfolio-policy.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "these",
  "this",
  "to",
  "was",
  "were",
  "with",
  "which",
  "who",
  "have",
  "has",
  "had",
  "been",
  "being",
  "also",
  "may",
  "can",
  "into",
  "over",
  "under",
  "via",
  "using",
  "used",
  "show",
  "shows",
  "showed",
  "shown",
  "suggest",
  "suggests",
  "suggested",
  "report",
  "reports",
  "reported",
  "study",
  "studies",
  "paper",
  "authors",
  "et",
  "al",
]);

const GENERIC_PHRASES = [
  "play a role",
  "important role",
  "involved in",
  "associated with",
  "has been shown",
  "it has been",
  "previous studies",
  "recent studies",
  "in the brain",
  "in neurons",
  "cell type",
  "cells",
];

export const claimShapeValues = [
  "atomic",
  "methods_protocol",
  "compound",
  "citing_meta",
] as const;

export const claimShapeSchema = z.enum(claimShapeValues);
export type ClaimShape = z.infer<typeof claimShapeSchema>;

/** Fixed utility multipliers — not CLI-configurable. */
const CLAIM_SHAPE_UTILITY_MULTIPLIER: Record<ClaimShape, number> = {
  atomic: 1,
  methods_protocol: 0.55,
  compound: 0.7,
  citing_meta: 0.65,
};

const METHODS_PROTOCOL_CLAIM_RE =
  /\b(?:anesthesia|anaesthesia|avertin|tribromoethanol|perfusion|immunohistochemistr|protocol|cryostat|paraformaldehyde|biological\s+replicates?|sections?\s+per\s+animal)\b/i;

const CITING_META_CLAIM_RE =
  /\b(?:prior\s+studies|previous\s+studies|previously\s+estimated|seed\s+paper\s+described|the\s+seed\s+paper\s+(?:described|provides|is\s+cited))\b/i;

const COMPOUND_CLAIM_RE =
  /;|\band\s+that\b|\b(?:as\s+well\s+as|along\s+with)\b.+\b(?:and|while|whereas)\b/i;

export const candidateSelectionAnnotationSchema = z
  .object({
    policyVersion: z.literal(CANDIDATE_SELECTION_POLICY_VERSION),
    uniqueCitingPaperCount: z.number().int().nonnegative(),
    uniqueCitationGroupCount: z.number().int().nonnegative(),
    sourceRecordCount: z.number().int().positive(),
    mentionCount: z.number().int().positive(),
    confidenceAggregate: z.number().min(0).max(1),
    specificityScore: z.number().min(0).max(1),
    informativeTokenCount: z.number().int().nonnegative(),
    namedOrAlphanumericTermCount: z.number().int().nonnegative(),
    quantityCount: z.number().int().nonnegative(),
    comparisonCount: z.number().int().nonnegative(),
    conditionCount: z.number().int().nonnegative(),
    genericLanguagePenalty: z.number().min(0).max(1),
    claimShape: claimShapeSchema,
    lexicalFingerprint: z
      .object({
        wordShingleHash: z.string().min(1),
        charShingleHash: z.string().min(1),
        wordShingles: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type CandidateSelectionAnnotation = z.infer<
  typeof candidateSelectionAnnotationSchema
>;

export const candidateSelectionDispositionSchema = z
  .object({
    candidateId: z.string().min(1),
    selectedForScope: z.boolean(),
    rank: z.number().int().positive(),
    reason: z.string().min(1),
    annotation: candidateSelectionAnnotationSchema,
    selectionStep: z.number().int().nonnegative().optional(),
    componentScores: z
      .object({
        prevalence: z.number(),
        specificity: z.number(),
        confidence: z.number(),
        novelty: z.number(),
        utility: z.number(),
      })
      .strict()
      .optional(),
    marginalUtility: z.number().optional(),
    projectedRecordCost: z.number().int().nonnegative().optional(),
    bindingConstraint: z
      .enum([
        "selected",
        "max_families",
        "max_prepared_records",
        "min_marginal_novelty",
        "exhausted",
      ])
      .optional(),
  })
  .strict();

export type CandidateSelectionDisposition = z.infer<
  typeof candidateSelectionDispositionSchema
>;

type AnnotatedCandidate = {
  candidate: DiscoverClaimCandidate;
  annotation: CandidateSelectionAnnotation;
  projectedRecordCost: number;
};

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function tokenize(normalizedClaim: string): string[] {
  return normalizedClaim
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function confidenceToScore(
  confidence: DiscoverAttributedClaimRecord["confidence"],
): number | undefined {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.6;
  if (confidence === "low") return 0.25;
  return undefined;
}

function shingles(tokens: readonly string[], size: number): string[] {
  if (tokens.length === 0) return [];
  if (tokens.length < size) return [tokens.join(" ")];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - size; i++) {
    out.push(tokens.slice(i, i + size).join(" "));
  }
  return out;
}

function charShingles(text: string, size: number): string[] {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) return [];
  if (compact.length < size) return [compact];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - size; i++) {
    out.push(compact.slice(i, i + size));
  }
  return out;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Lexical markers that can change citation-fidelity meaning. Claims that
 * differ on these markers must not be treated as redundant for novelty,
 * even when the surrounding wording overlaps heavily.
 */
const FIDELITY_MARKER_GROUPS: ReadonlyArray<{
  kind: string;
  pattern: RegExp;
}> = [
  {
    kind: "quantifier",
    pattern:
      /\b(?:mainly|primarily|largely|mostly|predominantly|substantially|many|most|some|all|few|several|none|every|any|majority|minority|half|nearly|almost|approximately|about|only|at\s+least|at\s+most|more|less|greater|fewer|increased|decreased|higher|lower)\b/gi,
  },
  {
    kind: "certainty",
    pattern:
      /\b(?:may|might|could|possibly|perhaps|likely|unlikely|apparently|seemingly|putative|potential|suggests?|suggested|appears?|seem(?:s|ed)?|clearly|definitely|established|known|thought|believed|evidence|prov(?:e|es|en)|demonstrat(?:e|es|ed)|indicat(?:e|es|ed))\b/gi,
  },
  {
    kind: "causality",
    pattern:
      /\b(?:cause[sd]?|because|due\s+to|leads?\s+to|leading\s+to|results?\s+in|resulting\s+in|induc(?:e|es|ed)|mediat(?:e|es|ed)|required\s+for|necessary\s+for|sufficient(?:\s+for)?|associated\s+with|correlat(?:e|es|ed|ion))\b/gi,
  },
  {
    kind: "polarity",
    pattern:
      /\b(?:not|no|never|neither|without|absent|lack(?:ing|s)?|fail(?:s|ed)?|non[a-z]+)\b/gi,
  },
  {
    kind: "condition",
    pattern:
      /\b(?:when|if|after|before|during|in\s+the\s+presence|in\s+the\s+absence|unless|under|following|upon|only\s+when|only\s+if)\b/gi,
  },
  {
    kind: "population",
    pattern:
      /\b(?:mice|mouse|human|humans|adult|adults|immature|mature|neonatal|male|female|wild[- ]?type|knockout|neurons?|cells?|patients?|subjects?)\b/gi,
  },
];

const FIDELITY_QUANTITY_PATTERN = /\b\d+(?:\.\d+)?%?\b/g;

export function extractFidelityMarkers(claimText: string): string[] {
  const markers = new Set<string>();
  const normalized = claimText.toLowerCase();
  for (const group of FIDELITY_MARKER_GROUPS) {
    group.pattern.lastIndex = 0;
    for (const match of normalized.matchAll(group.pattern)) {
      const token = match[0].replace(/\s+/g, " ").trim();
      if (token.length > 0) {
        markers.add(`${group.kind}:${token}`);
      }
    }
  }
  FIDELITY_QUANTITY_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(FIDELITY_QUANTITY_PATTERN)) {
    markers.add(`quantity:${match[0]}`);
  }
  return [...markers].sort(compareCodeUnits);
}

function fidelityMarkersDiffer(
  leftClaim: string,
  rightClaim: string,
): boolean {
  const left = extractFidelityMarkers(leftClaim);
  const right = extractFidelityMarkers(rightClaim);
  if (left.length !== right.length) return true;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return true;
  }
  return false;
}

function computeSpecificity(normalizedClaim: string): {
  specificityScore: number;
  informativeTokenCount: number;
  namedOrAlphanumericTermCount: number;
  quantityCount: number;
  comparisonCount: number;
  conditionCount: number;
  genericLanguagePenalty: number;
} {
  const tokens = tokenize(normalizedClaim);
  const informative = tokens.filter(
    (token) => token.length > 2 && !STOP_WORDS.has(token),
  );
  const namedOrAlphanumeric = tokens.filter(
    (token) =>
      /[0-9]/.test(token) ||
      (token.length >= 3 &&
        /[A-Z]/.test(token) === false &&
        /[a-z]{2,}/.test(token) &&
        !STOP_WORDS.has(token) &&
        (/[a-z]*[0-9][a-z0-9]*/.test(token) ||
          (token === token.toLowerCase() && token.length >= 5))),
  );
  // Prefer gene-like / alphanumeric and longer content tokens.
  const namedCount = tokens.filter(
    (token) =>
      /[0-9]/.test(token) ||
      /^[a-z]{0,3}\d+[a-z0-9]*$/i.test(token) ||
      (token.length >= 4 && !STOP_WORDS.has(token) && /[A-Z]/.test(token)),
  ).length;
  const quantityCount = (
    normalizedClaim.match(
      /\b\d+(?:\.\d+)?%?|\b(?:increased|decreased|higher|lower|more|less|greater|fewer)\b/g,
    ) ?? []
  ).length;
  const comparisonCount = (
    normalizedClaim.match(
      /\b(?:than|versus|vs|compared|relative to|higher than|lower than)\b/g,
    ) ?? []
  ).length;
  const conditionCount = (
    normalizedClaim.match(
      /\b(?:when|if|after|before|during|in the presence|in the absence|only|unless)\b/g,
    ) ?? []
  ).length;
  let genericHits = 0;
  for (const phrase of GENERIC_PHRASES) {
    if (normalizedClaim.includes(phrase)) genericHits += 1;
  }
  const genericLanguagePenalty = Math.min(1, genericHits / 4);
  const raw =
    Math.min(1, informative.length / 12) * 0.35 +
    Math.min(1, Math.max(namedCount, namedOrAlphanumeric.length) / 4) * 0.25 +
    Math.min(1, quantityCount / 3) * 0.15 +
    Math.min(1, comparisonCount / 2) * 0.1 +
    Math.min(1, conditionCount / 2) * 0.1 -
    genericLanguagePenalty * 0.25;
  return {
    specificityScore: Math.max(0, Math.min(1, raw)),
    informativeTokenCount: informative.length,
    namedOrAlphanumericTermCount: Math.max(
      namedCount,
      namedOrAlphanumeric.length,
    ),
    quantityCount,
    comparisonCount,
    conditionCount,
    genericLanguagePenalty,
  };
}

export function classifyClaimShape(input: {
  normalizedClaim: string;
  memberMentions: readonly DiscoverCitationOccurrence[];
}): ClaimShape {
  const claim = input.normalizedClaim;
  if (METHODS_PROTOCOL_CLAIM_RE.test(claim)) {
    return "methods_protocol";
  }
  const titled = input.memberMentions.filter((mention) => mention.sectionTitle);
  if (titled.length > 0) {
    const methodsMentions = titled.filter((mention) =>
      METHODS_SECTION_PATTERNS.some((re) => re.test(mention.sectionTitle ?? "")),
    ).length;
    if (methodsMentions * 2 >= titled.length) {
      return "methods_protocol";
    }
  }
  if (CITING_META_CLAIM_RE.test(claim)) {
    return "citing_meta";
  }
  if (COMPOUND_CLAIM_RE.test(claim)) {
    return "compound";
  }
  // Multi-clause heuristic: two+ sentence-like assertive segments.
  const clauses = claim
    .split(/(?<=[.!?])\s+|\s+,\s+(?:and|while|whereas)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 24);
  if (clauses.length >= 2) {
    return "compound";
  }
  return "atomic";
}

function portfolioUtility(input: {
  prevalence: number;
  specificity: number;
  confidence: number;
  novelty: number;
  claimShape: ClaimShape;
  policy: AdaptivePortfolioPolicy;
}): number {
  const base =
    input.prevalence * input.policy.prevalenceWeight +
    input.specificity * input.policy.specificityWeight +
    input.confidence * input.policy.confidenceWeight +
    input.novelty * input.policy.noveltyWeight;
  return base * CLAIM_SHAPE_UTILITY_MULTIPLIER[input.claimShape];
}

/**
 * Deterministic annotations for an atomic claim candidate. Near-paraphrases
 * remain separate candidates; a later equivalence consolidator can consume
 * these annotations without changing candidate IDs.
 */
export function annotateClaimCandidate(input: {
  candidate: DiscoverClaimCandidate;
  mentionsById: ReadonlyMap<string, DiscoverCitationOccurrence>;
  claimsById: ReadonlyMap<string, DiscoverAttributedClaimRecord>;
}): CandidateSelectionAnnotation {
  const papers = new Set<string>();
  const groups = new Set<string>();
  const memberMentions: DiscoverCitationOccurrence[] = [];
  for (const mentionId of input.candidate.memberMentionIds) {
    const mention = input.mentionsById.get(mentionId);
    if (!mention) continue;
    memberMentions.push(mention);
    papers.add(mention.citingPaperId);
    const groupKey = `${mention.citingPaperId}:${String(mention.citationGroupOrdinal ?? mention.mentionIndex)}`;
    groups.add(groupKey);
  }
  const confidenceScores = input.candidate.sourceClaimRecordIds
    .map((id) => confidenceToScore(input.claimsById.get(id)?.confidence))
    .filter((score): score is number => score != null);
  const confidenceAggregate =
    confidenceScores.length === 0
      ? 0.5
      : confidenceScores.reduce((sum, score) => sum + score, 0) /
        confidenceScores.length;
  const specificity = computeSpecificity(input.candidate.normalizedClaim);
  const tokens = tokenize(input.candidate.normalizedClaim).filter(
    (token) => !STOP_WORDS.has(token),
  );
  const wordShingles = shingles(tokens, 3);
  const char = charShingles(input.candidate.normalizedClaim, 4);
  return {
    policyVersion: CANDIDATE_SELECTION_POLICY_VERSION,
    uniqueCitingPaperCount: papers.size,
    uniqueCitationGroupCount: groups.size,
    sourceRecordCount: input.candidate.sourceClaimRecordIds.length,
    mentionCount: input.candidate.memberMentionIds.length,
    confidenceAggregate,
    specificityScore: specificity.specificityScore,
    informativeTokenCount: specificity.informativeTokenCount,
    namedOrAlphanumericTermCount: specificity.namedOrAlphanumericTermCount,
    quantityCount: specificity.quantityCount,
    comparisonCount: specificity.comparisonCount,
    conditionCount: specificity.conditionCount,
    genericLanguagePenalty: specificity.genericLanguagePenalty,
    claimShape: classifyClaimShape({
      normalizedClaim: input.candidate.normalizedClaim,
      memberMentions,
    }),
    lexicalFingerprint: {
      wordShingleHash: canonicalSha256(wordShingles),
      charShingleHash: canonicalSha256(char),
      wordShingles,
    },
  };
}

function normalizeScores(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) return values.map(() => 0.5);
  return values.map((value) => (value - min) / (max - min));
}

function maxRedundancy(
  candidate: AnnotatedCandidate,
  selected: readonly AnnotatedCandidate[],
): number {
  if (selected.length === 0) return 0;
  let max = 0;
  for (const prior of selected) {
    // Fidelity-sensitive wording differences keep novelty high.
    if (
      fidelityMarkersDiffer(
        candidate.candidate.normalizedClaim,
        prior.candidate.normalizedClaim,
      )
    ) {
      continue;
    }
    max = Math.max(
      max,
      jaccard(
        candidate.annotation.lexicalFingerprint.wordShingles,
        prior.annotation.lexicalFingerprint.wordShingles,
      ),
    );
  }
  return max;
}

/**
 * Adaptive portfolio selection under family and prepared-record budgets.
 * Stable candidate IDs are used only as the final tie-break.
 */
export function selectAdaptivePortfolio(input: {
  candidates: readonly DiscoverClaimCandidate[];
  mentions: readonly DiscoverCitationOccurrence[];
  claims: readonly DiscoverAttributedClaimRecord[];
  policy: AdaptivePortfolioPolicy;
}): CandidateSelectionDisposition[] {
  const mentionsById = new Map(
    input.mentions.map((mention) => [mention.mentionId, mention]),
  );
  const claimsById = new Map(
    input.claims.map((claim) => [claim.claimRecordId, claim]),
  );
  const annotated: AnnotatedCandidate[] = input.candidates.map((candidate) => {
    const annotation = annotateClaimCandidate({
      candidate,
      mentionsById,
      claimsById,
    });
    return {
      candidate,
      annotation,
      projectedRecordCost: Math.max(1, annotation.uniqueCitationGroupCount),
    };
  });

  const bySeed = new Map<string, AnnotatedCandidate[]>();
  for (const entry of annotated) {
    const list = bySeed.get(entry.candidate.seedId);
    if (list) list.push(entry);
    else bySeed.set(entry.candidate.seedId, [entry]);
  }

  const dispositions: CandidateSelectionDisposition[] = [];
  for (const seedId of [...bySeed.keys()].sort(compareCodeUnits)) {
    const seedCandidates = bySeed.get(seedId)!;
    const prevalenceRaw = seedCandidates.map(
      (entry) =>
        entry.annotation.uniqueCitingPaperCount * 2 +
        entry.annotation.uniqueCitationGroupCount,
    );
    const specificityRaw = seedCandidates.map(
      (entry) => entry.annotation.specificityScore,
    );
    const confidenceRaw = seedCandidates.map(
      (entry) => entry.annotation.confidenceAggregate,
    );
    const prevalence = normalizeScores(prevalenceRaw);
    const specificity = normalizeScores(specificityRaw);
    const confidence = normalizeScores(confidenceRaw);

    const scored = seedCandidates.map((entry, index) => ({
      entry,
      prevalence: prevalence[index]!,
      specificity: specificity[index]!,
      confidence: confidence[index]!,
    }));

    const selected: AnnotatedCandidate[] = [];
    const selectedIds = new Set<string>();
    let preparedCost = 0;
    let step = 0;
    const reasons = new Map<string, CandidateSelectionDisposition>();

    while (selected.length < input.policy.maxFamilies) {
      let best:
        | {
            scored: (typeof scored)[number];
            novelty: number;
            utility: number;
            marginal: number;
          }
        | undefined;
      for (const item of scored) {
        if (selectedIds.has(item.entry.candidate.candidateId)) continue;
        if (
          preparedCost + item.entry.projectedRecordCost >
            input.policy.maxPreparedRecords &&
          selected.length >= input.policy.minFamilies
        ) {
          continue;
        }
        if (
          preparedCost + item.entry.projectedRecordCost >
          input.policy.maxPreparedRecords
        ) {
          continue;
        }
        const redundancy = maxRedundancy(item.entry, selected);
        const novelty = 1 - redundancy;
        const utility = portfolioUtility({
          prevalence: item.prevalence,
          specificity: item.specificity,
          confidence: item.confidence,
          novelty,
          claimShape: item.entry.annotation.claimShape,
          policy: input.policy,
        });
        const marginal = utility;
        if (
          selected.length >= input.policy.minFamilies &&
          novelty < input.policy.minMarginalNovelty
        ) {
          continue;
        }
        if (
          !best ||
          marginal > best.marginal + 1e-12 ||
          (Math.abs(marginal - best.marginal) <= 1e-12 &&
            compareCodeUnits(
              item.entry.candidate.candidateId,
              best.scored.entry.candidate.candidateId,
            ) < 0)
        ) {
          best = { scored: item, novelty, utility, marginal };
        }
      }

      if (!best) break;
      step += 1;
      selected.push(best.scored.entry);
      selectedIds.add(best.scored.entry.candidate.candidateId);
      preparedCost += best.scored.entry.projectedRecordCost;
      reasons.set(best.scored.entry.candidate.candidateId, {
        candidateId: best.scored.entry.candidate.candidateId,
        selectedForScope: true,
        rank: step,
        reason: `Selected at portfolio step ${String(step)} (prevalence=${best.scored.prevalence.toFixed(2)}, specificity=${best.scored.specificity.toFixed(2)}, novelty=${best.novelty.toFixed(2)}, cost=${String(best.scored.entry.projectedRecordCost)}).`,
        annotation: best.scored.entry.annotation,
        selectionStep: step,
        componentScores: {
          prevalence: best.scored.prevalence,
          specificity: best.scored.specificity,
          confidence: best.scored.confidence,
          novelty: best.novelty,
          utility: best.utility,
        },
        marginalUtility: best.marginal,
        projectedRecordCost: best.scored.entry.projectedRecordCost,
        bindingConstraint: "selected",
      });
    }

    // Rank deferred candidates after selected, by unused utility then id.
    const deferred = scored
      .filter((item) => !selectedIds.has(item.entry.candidate.candidateId))
      .sort((left, right) => {
        const leftNovelty = 1 - maxRedundancy(left.entry, selected);
        const rightNovelty = 1 - maxRedundancy(right.entry, selected);
        const leftUtility = portfolioUtility({
          prevalence: left.prevalence,
          specificity: left.specificity,
          confidence: left.confidence,
          novelty: leftNovelty,
          claimShape: left.entry.annotation.claimShape,
          policy: input.policy,
        });
        const rightUtility = portfolioUtility({
          prevalence: right.prevalence,
          specificity: right.specificity,
          confidence: right.confidence,
          novelty: rightNovelty,
          claimShape: right.entry.annotation.claimShape,
          policy: input.policy,
        });
        if (rightUtility !== leftUtility) return rightUtility - leftUtility;
        return compareCodeUnits(
          left.entry.candidate.candidateId,
          right.entry.candidate.candidateId,
        );
      });

    let rank = selected.length;
    for (const item of deferred) {
      rank += 1;
      const novelty = 1 - maxRedundancy(item.entry, selected);
      const utility = portfolioUtility({
        prevalence: item.prevalence,
        specificity: item.specificity,
        confidence: item.confidence,
        novelty,
        claimShape: item.entry.annotation.claimShape,
        policy: input.policy,
      });
      let bindingConstraint: CandidateSelectionDisposition["bindingConstraint"] =
        "exhausted";
      if (selected.length >= input.policy.maxFamilies) {
        bindingConstraint = "max_families";
      } else if (
        preparedCost + item.entry.projectedRecordCost >
        input.policy.maxPreparedRecords
      ) {
        bindingConstraint = "max_prepared_records";
      } else if (
        selected.length >= input.policy.minFamilies &&
        novelty < input.policy.minMarginalNovelty
      ) {
        bindingConstraint = "min_marginal_novelty";
      }
      reasons.set(item.entry.candidate.candidateId, {
        candidateId: item.entry.candidate.candidateId,
        selectedForScope: false,
        rank,
        reason: `Deferred by adaptive portfolio (${bindingConstraint}) at rank ${String(rank)}.`,
        annotation: item.entry.annotation,
        componentScores: {
          prevalence: item.prevalence,
          specificity: item.specificity,
          confidence: item.confidence,
          novelty,
          utility,
        },
        marginalUtility: utility,
        projectedRecordCost: item.entry.projectedRecordCost,
        bindingConstraint,
      });
    }

    // Contiguous ranks 1..n in selection order then deferred order.
    const ordered = [
      ...selected.map((entry) => reasons.get(entry.candidate.candidateId)!),
      ...deferred.map((item) => reasons.get(item.entry.candidate.candidateId)!),
    ];
    ordered.forEach((disposition, index) => {
      dispositions.push({
        ...disposition,
        rank: index + 1,
      });
    });
  }

  return dispositions.sort((left, right) => {
    const seedLeft =
      input.candidates.find((c) => c.candidateId === left.candidateId)
        ?.seedId ?? "";
    const seedRight =
      input.candidates.find((c) => c.candidateId === right.candidateId)
        ?.seedId ?? "";
    if (seedLeft !== seedRight) return compareCodeUnits(seedLeft, seedRight);
    return left.rank - right.rank;
  });
}
