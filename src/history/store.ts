import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import {
  artifactIdSchema,
  artifactReferenceSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type ArtifactReference,
} from "../contract/artifacts/primitives.js";
import {
  discoverCitationOccurrenceSchema,
  discoverCitingPaperRecordSchema,
  discoverClaimSupportSpanSchema,
} from "../contract/artifacts/discover.js";
import { scopeSeedFindingSchema } from "../contract/artifacts/scope-statements.js";
import {
  citationObservationParserMatches,
  contextMarkerSpanSchema,
  type ParsedPaperDocument,
} from "../domain/parsing.js";
import { createProvenanceStore } from "../pipeline/provenance-store.js";
import { loadJsonArtifact } from "../shared/artifact-io.js";
import { buildStableId, canonicalSha256 } from "../shared/stable-identity.js";

import { historyAssessmentSchema } from "./assessment.js";
import { locateHistoryCitationBlock } from "./parent-citation.js";
import { decodeCitingPaperParse } from "./parsed-source.js";

const historyVersion = "citation-history-v3";
const text = z.string().min(1);
const refs = z.array(artifactReferenceSchema);
const sourceVersion =
  discoverCitationOccurrenceSchema.shape.observationProvenance;
const count = z.number().int().nonnegative();

export const reportIdentitySchema = z.strictObject({
  runId: text,
  artifactId: artifactIdSchema,
  contentHash: sha256DigestSchema,
});
type ReportIdentity = z.infer<typeof reportIdentitySchema>;

export const citationHistoryLimitsSchema = z.strictObject({
  maxParents: z.number().int().positive(),
  maxCiters: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  maxHops: z.literal(2),
});

export const historyPaperSchema = z.strictObject({
  paperId: text,
  title: text,
  doi: text.optional(),
  publicationYear: z.number().int().optional(),
});
export type HistoryPaper = z.infer<typeof historyPaperSchema>;

export const historyDirectCitationSchema = z.strictObject({
  status: z.enum([
    "same_group",
    "elsewhere",
    "bibliography_only",
    "no_match_in_parsed_references",
    "unknown",
  ]),
  referenceIds: z.array(text),
  provenanceArtifacts: refs,
});
export type HistoryDirectCitation = z.infer<typeof historyDirectCitationSchema>;

const firstHopRelationship = z.enum([
  "full",
  "partial",
  "scope_changed",
  "distinct",
  "uncertain",
  "unassessed",
]);
const firstHop = z.strictObject({
  relationship: firstHopRelationship,
  sourceVersion,
  occurrenceId: stableIdentifierSchema,
  claimRecordId: stableIdentifierSchema,
  text: text.optional(),
  context: z.string(),
  citationMarker: z.string(),
  markerSpan: contextMarkerSpanSchema.optional(),
  sourceLocator: discoverCitationOccurrenceSchema.shape.sourceLocator,
  citationGroupOrdinal: count.optional(),
  supportSpan: discoverClaimSupportSpanSchema.optional(),
  findingIds: z.array(stableIdentifierSchema),
  findings: z.array(scopeSeedFindingSchema),
  credit: z.enum(["single_reference", "shared_reference_group", "unverified"]),
  retained: z.array(text),
  changes: z.array(text),
  reason: text,
  provenanceArtifacts: refs,
});

const citationUse = z.strictObject({
  useId: stableIdentifierSchema,
  middlePaperId: text,
  citing: historyPaperSchema,
  occurrenceId: stableIdentifierSchema,
  mentionIndex: count,
  sourceLocator: discoverCitationOccurrenceSchema.shape.sourceLocator,
  citationGroupOrdinal: count.optional(),
  targetRefIds: z.array(text),
  bibliographyMatch: discoverCitingPaperRecordSchema.shape.bibliographyMatch,
  charOffsetStart: count.optional(),
  charOffsetEnd: count.optional(),
  claimRecordId: stableIdentifierSchema.optional(),
  statementId: stableIdentifierSchema.optional(),
  statementText: text.optional(),
  credit: z
    .enum(["single_reference", "shared_reference_group", "unverified"])
    .optional(),
  context: z.string(),
  citationMarker: z.string(),
  observationProvenance: sourceVersion,
  markerSpan: contextMarkerSpanSchema.optional(),
  supportSpan: discoverClaimSupportSpanSchema.optional(),
  provenanceArtifacts: refs,
});
export type HistoryCitationUse = z.infer<typeof citationUse>;

export function historyCitationUseId(
  middlePaperId: string,
  occurrenceId: string,
  sourceTextHash: string | undefined,
  statementId?: string,
): string {
  return buildStableId("history-citation-use", {
    middlePaperId,
    occurrenceId,
    sourceTextHash: sourceTextHash ?? null,
    statementId: statementId ?? null,
  });
}

export function historyAssessmentCaseId(
  statementId: string,
  useId: string,
  findingId: string,
): string {
  return buildStableId("history-assessment-case", {
    statementId,
    useId,
    findingId,
  });
}

const laterHop = z.strictObject({
  useId: stableIdentifierSchema,
  status: z.enum([
    "assessed",
    "unassessed",
    "invalid_output",
    "provider_failure",
    "budget_exhausted",
  ]),
  assessments: z.array(historyAssessmentSchema),
  reason: text,
  directCitation: historyDirectCitationSchema,
  provenanceArtifacts: refs,
});
export type HistoryLaterHop = z.infer<typeof laterHop>;

const citationHistoryPath = z.strictObject({
  statementId: stableIdentifierSchema,
  original: historyPaperSchema,
  middle: historyPaperSchema,
  firstHop,
  laterHops: z.array(laterHop),
});
export type CitationHistoryPath = z.infer<typeof citationHistoryPath>;

const citerStatus = z.enum([
  "assessed",
  "no_in_text_citation",
  "no_attributed_statement",
  "not_probed",
  "access_unavailable",
  "examination_failed",
  "budget_exhausted",
]);
export type HistoryCiterStatus = z.infer<typeof citerStatus>;

const citationHistoryNeighborhood = z.strictObject({
  middle: historyPaperSchema,
  status: z.enum([
    "examined",
    "missing_doi",
    "neighborhood_unavailable",
    "citer_budget_exhausted",
    "cost_budget_exhausted",
  ]),
  reason: text,
  coverage: z.enum(["complete", "truncated", "unknown"]),
  providerReportedTotal: count.optional(),
  omittedCount: count,
  allocatedCiterLimit: count,
  sourceReport: reportIdentitySchema.optional(),
  middleSource: z
    .strictObject({
      status: z.enum(["available", "unavailable", "source_version_unverified"]),
      reason: text,
      textVersionId: stableIdentifierSchema.optional(),
      sourceArtifact: artifactReferenceSchema.optional(),
      provenanceArtifacts: refs,
    })
    .optional(),
  citers: z.array(
    z.strictObject({
      paper: historyPaperSchema,
      status: citerStatus,
      reason: text,
      provenanceArtifacts: refs,
    }),
  ),
  provenanceArtifacts: refs,
});
export type CitationHistoryNeighborhood = z.infer<
  typeof citationHistoryNeighborhood
>;

const citationHistoryPayloadSchema = z.strictObject({
  report: reportIdentitySchema,
  limits: citationHistoryLimitsSchema,
  selection: z.strictObject({
    candidateCount: count,
    eligibleCount: count,
    selectedCount: count,
    explicitStatementIds: z.array(stableIdentifierSchema),
  }),
  paths: z.array(citationHistoryPath),
  citationUses: z.array(citationUse),
  neighborhoods: z.array(citationHistoryNeighborhood),
});
export type CitationHistoryPayload = z.infer<
  typeof citationHistoryPayloadSchema
>;

const citationHistoryArtifactSchema = z.strictObject({
  schemaVersion: z.literal(historyVersion),
  artifactId: artifactIdSchema,
  contentHash: sha256DigestSchema,
  payload: citationHistoryPayloadSchema,
});
export type CitationHistoryArtifact = z.infer<
  typeof citationHistoryArtifactSchema
>;

function historyIdentity(payload: CitationHistoryPayload) {
  const contentHash = canonicalSha256(payload);
  return {
    contentHash,
    artifactId: buildStableId("artifact", {
      schemaVersion: historyVersion,
      contentHash,
    }),
  };
}

function verifyPayload(payload: CitationHistoryPayload): void {
  const { selection, limits, paths, neighborhoods } = payload;
  if (
    selection.eligibleCount > selection.candidateCount ||
    selection.selectedCount !== paths.length ||
    selection.selectedCount > limits.maxParents ||
    selection.selectedCount > selection.eligibleCount ||
    new Set(paths.map((path) => path.statementId)).size !== paths.length ||
    neighborhoods.reduce((sum, item) => sum + item.citers.length, 0) >
      limits.maxCiters
  ) {
    throw new Error("Citation history selection exceeds its declared bounds");
  }
  const byMiddlePaper = new Map(
    neighborhoods.map((item) => [item.middle.paperId, item]),
  );
  if (byMiddlePaper.size !== neighborhoods.length) {
    throw new Error(
      "Citation history has duplicate middle paper neighborhoods",
    );
  }
  if (
    neighborhoods.some((item) => item.citers.length > item.allocatedCiterLimit)
  ) {
    throw new Error(
      "Citation history neighborhood exceeds its declared citer allocation",
    );
  }
  if (
    neighborhoods.some(
      ({ middleSource }) =>
        middleSource &&
        ((middleSource.status === "available" &&
          (!middleSource.textVersionId ||
            middleSource.textVersionId !==
              middleSource.sourceArtifact?.artifactId)) ||
          (middleSource.status !== "available" &&
            middleSource.textVersionId !== undefined)),
    )
  ) {
    throw new Error(
      "Citation history has an inconsistent intermediate source identity",
    );
  }
  const uses = new Map(payload.citationUses.map((use) => [use.useId, use]));
  if (uses.size !== payload.citationUses.length) {
    throw new Error("Citation history has duplicate downstream citation uses");
  }
  const citerIds = new Map(
    neighborhoods.map((item) => [
      item.middle.paperId,
      new Set(item.citers.map((row) => row.paper.paperId)),
    ]),
  );
  if (
    neighborhoods.some(
      (item) => citerIds.get(item.middle.paperId)?.size !== item.citers.length,
    )
  ) {
    throw new Error(
      "Citation history has duplicate citing papers in a neighborhood",
    );
  }
  for (const use of uses.values()) {
    const { context, markerSpan, supportSpan } = use;
    if (
      use.useId !==
        historyCitationUseId(
          use.middlePaperId,
          use.occurrenceId,
          use.observationProvenance.sourceTextHash,
          use.statementId,
        ) ||
      !citerIds.get(use.middlePaperId)?.has(use.citing.paperId)
    ) {
      throw new Error("Downstream citation use does not join its neighborhood");
    }
    if (
      (markerSpan &&
        context.slice(markerSpan.charOffsetStart, markerSpan.charOffsetEnd) !==
          use.citationMarker) ||
      (supportSpan &&
        (supportSpan.charOffsetEnd - supportSpan.charOffsetStart !==
          supportSpan.text.length ||
          context.slice(
            supportSpan.charOffsetStart,
            supportSpan.charOffsetEnd,
          ) !== supportSpan.text))
    ) {
      throw new Error(
        "Downstream citation evidence does not match its source text",
      );
    }
  }
  const referencedUses = new Set<string>();
  for (const path of paths) {
    const neighborhood = byMiddlePaper.get(path.middle.paperId);
    if (
      !neighborhood ||
      new Set(path.laterHops.map((hop) => hop.useId)).size !==
        path.laterHops.length
    ) {
      throw new Error("Citation history path does not join its neighborhood");
    }
    const first = path.firstHop;
    const findingIds = new Set(first.findingIds);
    if (
      findingIds.size !== first.findingIds.length ||
      first.findings.length !== findingIds.size ||
      new Set(first.findings.map((finding) => finding.findingId)).size !==
        findingIds.size ||
      first.findings.some((finding) => !findingIds.has(finding.findingId))
    ) {
      throw new Error(
        "First-hop finding IDs do not match their grounded findings",
      );
    }
    if (
      first.supportSpan &&
      first.context.slice(
        first.supportSpan.charOffsetStart,
        first.supportSpan.charOffsetEnd,
      ) !== first.supportSpan.text
    ) {
      throw new Error("First-hop statement does not match its source text");
    }
    for (const hop of path.laterHops) {
      const use = uses.get(hop.useId);
      if (!use || use.middlePaperId !== path.middle.paperId) {
        throw new Error(
          "Citation history path does not join its downstream use",
        );
      }
      referencedUses.add(hop.useId);
      const statuses = new Set(hop.assessments.map((item) => item.status));
      const expectedStatus =
        (
          [
            "assessed",
            "invalid_output",
            "provider_failure",
            "budget_exhausted",
          ] as const
        ).find((status) => statuses.has(status)) ?? "unassessed";
      if (hop.status !== expectedStatus) {
        throw new Error(
          "Citation history link status does not match its assessments",
        );
      }
      const expectedAssessments =
        first.text &&
        first.credit !== "unverified" &&
        use.statementId &&
        use.supportSpan &&
        (use.credit === "single_reference" ||
          use.credit === "shared_reference_group")
          ? findingIds.size
          : 0;
      if (hop.assessments.length !== expectedAssessments) {
        throw new Error(
          "Citation history does not account for each eligible original finding",
        );
      }
      const assessedFindings = new Set<string>();
      for (const item of hop.assessments) {
        if (
          !findingIds.has(item.findingId) ||
          assessedFindings.has(item.findingId) ||
          item.caseId !==
            historyAssessmentCaseId(path.statementId, hop.useId, item.findingId)
        ) {
          throw new Error(
            "Citation history assessment does not join its original finding",
          );
        }
        assessedFindings.add(item.findingId);
        if (item.status !== "assessed") continue;
        if (
          !use.statementId ||
          !use.credit ||
          use.credit === "unverified" ||
          !use.markerSpan ||
          !use.supportSpan ||
          !item.downstreamQuote.trim() ||
          !use.supportSpan.text.includes(item.downstreamQuote) ||
          item.comparison.retained.some(
            (phrase) =>
              !phrase.trim() || !item.downstreamQuote.includes(phrase),
          )
        ) {
          throw new Error(
            "Citation history assessment lacks verified downstream evidence",
          );
        }
        if (
          (item.parentEvidenceStatus !== "available" &&
            (item.route.kind !== "unresolved" ||
              item.immediateFidelity.status === "assessed")) ||
          (item.parentEvidenceStatus !== "unavailable" &&
            !item.parentTextVersionId)
        ) {
          throw new Error(
            "Citation history route lacks a verified intermediate source",
          );
        }
        if (!item.parentTextVersionId) continue;
        if (
          neighborhood.middleSource?.status !== "available" ||
          neighborhood.middleSource.textVersionId !==
            item.parentTextVersionId ||
          neighborhood.middleSource.sourceArtifact?.artifactId !==
            item.parentTextVersionId
        ) {
          throw new Error(
            "Citation history assessment refers to a different intermediate source",
          );
        }
      }
    }
  }
  if (referencedUses.size !== uses.size) {
    throw new Error(
      "Citation history has unreferenced downstream citation uses",
    );
  }
}

const immutableTextSchema = z.object({
  sourceTextHash: sha256DigestSchema,
  parserKind: text,
  parserVersion: text,
  blocks: z.array(
    z.object({
      blockId: text,
      text: z.string(),
      charOffsetStart: count,
    }),
  ),
});

function verifySourceEvidence(
  root: string,
  payload: CitationHistoryPayload,
): void {
  let store: ReturnType<typeof createProvenanceStore> | undefined;
  const readBody = (reference: ArtifactReference) =>
    (store ??= createProvenanceStore(root)).load(reference).body;
  const sources = new Map<string, z.infer<typeof immutableTextSchema>>();
  const readSource = (reference: ArtifactReference) => {
    const key = `${reference.artifactId}:${reference.contentHash}`;
    if (reference.role !== "immutable-seed-text") {
      throw new Error("History source is not an immutable parsed paper");
    }
    const known = sources.get(key);
    if (known) return known;
    const body = readBody(reference);
    const source = immutableTextSchema.parse(body);
    sources.set(key, source);
    return source;
  };
  const assessedUses = new Set(
    payload.paths.flatMap(({ laterHops }) =>
      laterHops
        .filter(({ assessments }) => assessments.length > 0)
        .map(({ useId }) => useId),
    ),
  );
  const parsedCitingPapers = new Map<
    string,
    {
      paperId: string;
      sourceTextHash: string;
      parserKind: ParsedPaperDocument["parserKind"];
      parserVersion: string;
      referenceIds: Set<string>;
      mentions: Map<number, ParsedPaperDocument["mentions"][number]>;
    }
  >();
  for (const use of payload.citationUses) {
    const version = use.observationProvenance;
    const references = version.artifacts.filter(
      ({ role }) => role === "citing-paper-parse",
    );
    if (assessedUses.has(use.useId) && references.length !== 1) {
      throw new Error(
        "Downstream assessment requires one immutable citing-paper parse",
      );
    }
    for (const reference of references) {
      const key = `${reference.artifactId}:${reference.contentHash}`;
      let parsed = parsedCitingPapers.get(key);
      if (!parsed) {
        const { paperId, sourceTextHash, document } = decodeCitingPaperParse(
          readBody(reference),
        );
        parsed = {
          paperId,
          sourceTextHash,
          parserKind: document.parserKind,
          parserVersion: document.parserVersion,
          referenceIds: new Set(document.references.map(({ refId }) => refId)),
          mentions: new Map(
            document.mentions.map((mention) => [mention.mentionIndex, mention]),
          ),
        };
        parsedCitingPapers.set(key, parsed);
      }
      if (
        parsed.paperId !== use.citing.paperId ||
        parsed.sourceTextHash !== version.sourceTextHash ||
        !citationObservationParserMatches(version.parser, parsed.parserKind) ||
        parsed.parserVersion !== version.parserVersion
      ) {
        throw new Error(
          "Downstream citation does not match its parse provenance",
        );
      }
      if (!assessedUses.has(use.useId)) continue;
      const mention = parsed.mentions.get(use.mentionIndex);
      if (
        mention?.locationQuality !== "exact_dom" ||
        mention.sourceType !== version.sourceType ||
        mention.rawContext !== use.context ||
        mention.citationMarker !== use.citationMarker ||
        mention.markerSpan?.charOffsetStart !==
          use.markerSpan?.charOffsetStart ||
        mention.markerSpan?.charOffsetEnd !== use.markerSpan?.charOffsetEnd ||
        mention.sourceLocator?.kind !== use.sourceLocator?.kind ||
        mention.sourceLocator?.value !== use.sourceLocator?.value ||
        mention.charOffsetStart !== use.charOffsetStart ||
        mention.charOffsetEnd !== use.charOffsetEnd ||
        mention.citationGroupOrdinal !== use.citationGroupOrdinal ||
        !use.bibliographyMatch ||
        !parsed.referenceIds.has(use.bibliographyMatch.refId) ||
        !use.targetRefIds.includes(use.bibliographyMatch.refId) ||
        canonicalSha256([...mention.targetRefIds].sort()) !==
          canonicalSha256([...use.targetRefIds].sort())
      ) {
        throw new Error(
          "Downstream citation does not match its exact occurrence in the saved source",
        );
      }
    }
  }
  const byMiddlePaper = new Map(
    payload.neighborhoods.map((item) => [item.middle.paperId, item]),
  );
  for (const path of payload.paths) {
    for (const finding of path.firstHop.findings) {
      for (const quote of finding.evidenceSpans) {
        const source = readSource(quote.sourceArtifact);
        const block = source.blocks.find(
          ({ blockId }) => blockId === quote.blockId,
        );
        if (
          !block ||
          quote.charOffsetStart < block.charOffsetStart ||
          quote.charOffsetEnd - quote.charOffsetStart !== quote.text.length ||
          block.text.slice(
            quote.charOffsetStart - block.charOffsetStart,
            quote.charOffsetEnd - block.charOffsetStart,
          ) !== quote.text
        ) {
          throw new Error(
            "Original finding quote does not match its immutable source",
          );
        }
      }
    }
    const parentArtifact = byMiddlePaper.get(path.middle.paperId)?.middleSource
      ?.sourceArtifact;
    if (!parentArtifact) continue;
    for (const hop of path.laterHops) {
      for (const assessment of hop.assessments) {
        if (assessment.status !== "assessed" || !assessment.parentTextVersionId)
          continue;
        const source = readSource(parentArtifact);
        const version = path.firstHop.sourceVersion;
        if (
          version.sourceTextHash !== source.sourceTextHash ||
          !citationObservationParserMatches(
            version.parser,
            source.parserKind,
          ) ||
          version.parserVersion !== source.parserVersion
        ) {
          throw new Error(
            "Intermediate evidence does not match the first-hop source version",
          );
        }
        const { route } = assessment;
        if (route.kind === "direct_restatement") {
          const first = path.firstHop;
          const blockId = locateHistoryCitationBlock(source.blocks, {
            context: first.context,
            marker: first.citationMarker,
            markerSpan: first.markerSpan,
            sourceLocator: first.sourceLocator,
            ...(first.citationGroupOrdinal === undefined
              ? {}
              : { citationGroupOrdinal: first.citationGroupOrdinal }),
          });
          if (
            !blockId ||
            route.connection.some((quote) => quote.blockId !== blockId)
          ) {
            throw new Error(
              "Direct restatement evidence does not match the credited first-hop paragraph",
            );
          }
        }
        const quotes = [
          ...("connection" in route ? route.connection : []),
          ...("contribution" in route ? route.contribution : []),
          ...(assessment.immediateFidelity.status === "assessed"
            ? assessment.immediateFidelity.evidence
            : []),
        ];
        for (const quote of quotes) {
          const blocks = source.blocks.filter(
            ({ blockId }) => blockId === quote.blockId,
          );
          const block = blocks[0];
          if (
            blocks.length !== 1 ||
            !block ||
            quote.end - quote.start !== quote.text.length ||
            block.text.slice(quote.start, quote.end) !== quote.text ||
            block.text.indexOf(quote.text) !== quote.start ||
            block.text.indexOf(quote.text, quote.start + 1) >= 0
          ) {
            throw new Error(
              "Intermediate route quote does not match its immutable source",
            );
          }
        }
      }
    }
  }
}

export function createCitationHistoryArtifact(
  payload: CitationHistoryPayload,
): CitationHistoryArtifact {
  const parsed = citationHistoryPayloadSchema.parse(payload);
  verifyPayload(parsed);
  return {
    schemaVersion: historyVersion,
    ...historyIdentity(parsed),
    payload: parsed,
  };
}

export function citationHistoryRoot(
  runRoot: string,
  report: ReportIdentity,
): string {
  return resolve(runRoot, "history", artifactIdSchema.parse(report.artifactId));
}

export function writeCitationHistory(
  runRoot: string,
  artifact: CitationHistoryArtifact,
): string {
  const validated = createCitationHistoryArtifact(artifact.payload);
  if (
    artifact.schemaVersion !== validated.schemaVersion ||
    artifact.artifactId !== validated.artifactId ||
    artifact.contentHash !== validated.contentHash
  ) {
    throw new Error("Cannot write citation history with inconsistent identity");
  }
  const reportRoot = citationHistoryRoot(runRoot, artifact.payload.report);
  verifySourceEvidence(reportRoot, validated.payload);
  const root = resolve(reportRoot, historyVersion, artifact.artifactId);
  mkdirSync(root, { recursive: true });
  const path = resolve(root, "history.json");
  const temporary = resolve(root, randomUUID() + ".tmp");
  writeFileSync(temporary, JSON.stringify(validated, null, 2) + "\n", {
    flush: true,
  });
  renameSync(temporary, path);
  return path;
}

export function loadCitationHistory(
  runRoot: string,
  report: ReportIdentity,
  artifactId: string,
): CitationHistoryArtifact {
  const reported = reportIdentitySchema.parse(report);
  const path = resolve(
    citationHistoryRoot(runRoot, reported),
    historyVersion,
    artifactIdSchema.parse(artifactId),
    "history.json",
  );
  const artifact = loadJsonArtifact(
    path,
    citationHistoryArtifactSchema,
    "citation history",
  );
  const identity = historyIdentity(artifact.payload);
  if (
    artifact.artifactId !== artifactId ||
    artifact.artifactId !== identity.artifactId ||
    artifact.contentHash !== identity.contentHash
  ) {
    throw new Error("Citation history content hash mismatch at " + path);
  }
  if (canonicalSha256(artifact.payload.report) !== canonicalSha256(reported)) {
    throw new Error(
      "Citation history is bound to a different report at " + path,
    );
  }
  verifyPayload(artifact.payload);
  verifySourceEvidence(
    citationHistoryRoot(runRoot, reported),
    artifact.payload,
  );
  return artifact;
}

export function listCitationHistory(
  runRoot: string,
  report: ReportIdentity,
): CitationHistoryArtifact[] {
  const root = resolve(citationHistoryRoot(runRoot, report), historyVersion);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        artifactIdSchema.safeParse(entry.name).success &&
        existsSync(resolve(root, entry.name, "history.json")),
    )
    .map((entry) => entry.name)
    .sort()
    .map((artifactId) => loadCitationHistory(runRoot, report, artifactId));
}
