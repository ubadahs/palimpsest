import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  citationHistoryRoot,
  createCitationHistoryArtifact,
  historyAssessmentCaseId,
  historyCitationUseId,
  listCitationHistory,
  loadCitationHistory,
  writeCitationHistory,
  type CitationHistoryPayload,
} from "../../src/history/store.js";
import { parseParsedPaperDocument } from "../../src/retrieval/parsed-paper.js";
import { createProvenanceStore } from "../../src/pipeline/provenance-store.js";
import { buildStableId, sha256Text } from "../../src/shared/stable-identity.js";

it("stores a shared downstream use once and verifies source-bound route quotes", () => {
  const root = mkdtempSync(join(tmpdir(), "citation-history-store-"));
  try {
    const report = {
      runId: "run",
      artifactId: buildStableId("artifact", "report"),
      contentHash: sha256Text("report"),
    };
    const store = createProvenanceStore(citationHistoryRoot(root, report));
    const originalText = "An average effect was observed.";
    const middleText = "The subgroup had a larger effect.";
    const makeSource = (blockText: string, charOffsetStart: number) =>
      store.persist({
        role: "immutable-seed-text",
        body: {
          sourceTextHash: sha256Text(blockText),
          parserKind: "grobid_tei",
          parserVersion: "v1",
          blocks: [{ blockId: "results", text: blockText, charOffsetStart }],
        },
      });
    const originalSource = makeSource(originalText, 10);
    const middleSource = makeSource(middleText, 0);
    const original = { paperId: "seed", title: "Trial" };
    const middle = {
      paperId: "middle",
      title: "Subgroup analysis",
      doi: "10.1234/subgroups",
    };
    const citing = { paperId: "downstream", title: "Review" };
    const occurrenceId = buildStableId("occurrence", "downstream");
    const claimRecordId = buildStableId("claim", "downstream");
    const findingId = buildStableId("finding", "original");
    const support = "A larger effect was found";
    const sourceText = `<article><body><p>${support} <xref ref-type="bibr" rid="middle">[7]</xref>.</p></body><back><ref-list><ref id="middle"><element-citation><article-title>Subgroup analysis</article-title><pub-id pub-id-type="doi">${middle.doi}</pub-id></element-citation></ref></ref-list></back></article>`;
    const parsed = parseParsedPaperDocument(sourceText, "jats_xml");
    if (!parsed.ok) throw new Error(parsed.error);
    const mention = parsed.data.mentions[0];
    if (!mention?.markerSpan)
      throw new Error("Test source has no exact citation");
    const digest = sha256Text(sourceText);
    const statementId = buildStableId("statement", "downstream");
    const useId = historyCitationUseId(
      middle.paperId,
      occurrenceId,
      digest,
      statementId,
    );
    expect(
      historyCitationUseId(
        middle.paperId,
        occurrenceId,
        sha256Text("earlier source"),
        statementId,
      ),
    ).not.toBe(useId);
    const version = {
      sourceType: "tei",
      parser: "grobid-tei",
      parserVersion: "v1",
      sourceTextHash: sha256Text(middleText),
      artifacts: [middleSource],
    };
    const citingParse = store.persist({
      role: "citing-paper-parse",
      body: {
        citingPaperId: citing.paperId,
        sourceTextHash: digest,
        parserKind: parsed.data.parserKind,
        parserVersion: parsed.data.parserVersion,
        sourceText,
        fullTextFormat: "jats_xml",
      },
    });
    const payload: CitationHistoryPayload = {
      report,
      limits: { maxHops: 2, maxParents: 2, maxCiters: 1, maxCostUsd: 0 },
      selection: {
        eligibleCount: 2,
        candidateCount: 2,
        selectedCount: 2,
        explicitStatementIds: [],
      },
      citationUses: [
        {
          useId,
          middlePaperId: middle.paperId,
          citing,
          occurrenceId,
          claimRecordId,
          mentionIndex: mention.mentionIndex,
          targetRefIds: mention.targetRefIds,
          bibliographyMatch: { method: "doi", refId: "middle" },
          ...(mention.sourceLocator
            ? { sourceLocator: mention.sourceLocator }
            : {}),
          ...(mention.charOffsetStart !== undefined
            ? { charOffsetStart: mention.charOffsetStart }
            : {}),
          ...(mention.charOffsetEnd !== undefined
            ? { charOffsetEnd: mention.charOffsetEnd }
            : {}),
          citationGroupOrdinal: mention.citationGroupOrdinal,
          observationProvenance: {
            sourceType: mention.sourceType,
            sourceTextHash: digest,
            parser: mention.parser,
            parserVersion: parsed.data.parserVersion,
            artifacts: [citingParse],
          },
          statementId,
          statementText: support,
          credit: "single_reference",
          context: mention.rawContext,
          citationMarker: mention.citationMarker,
          markerSpan: mention.markerSpan,
          supportSpan: {
            charOffsetStart: 0,
            charOffsetEnd: support.length,
            text: support,
            verificationStatus: "verified_exact",
          },
          provenanceArtifacts: [],
        },
      ],
      neighborhoods: [
        {
          middle,
          status: "examined",
          reason: "All known citers examined.",
          coverage: "complete",
          omittedCount: 0,
          allocatedCiterLimit: 1,
          middleSource: {
            status: "available",
            reason: "Matched the parsed first hop.",
            textVersionId: middleSource.artifactId,
            sourceArtifact: middleSource,
            provenanceArtifacts: [],
          },
          citers: [
            {
              paper: citing,
              status: "assessed",
              reason: "Compared.",
              provenanceArtifacts: [],
            },
          ],
          provenanceArtifacts: [],
        },
      ],
      paths: [1, 2].map((index) => {
        const statementId = buildStableId("statement", index);
        return {
          statementId,
          original,
          middle,
          firstHop: {
            relationship: "full",
            occurrenceId: buildStableId("occurrence", index),
            claimRecordId: buildStableId("claim", index),
            sourceVersion: version,
            text: originalText,
            context: originalText + " [2]",
            citationMarker: "[2]",
            markerSpan: {
              charOffsetStart: originalText.length + 1,
              charOffsetEnd: originalText.length + 4,
            },
            findingIds: [findingId],
            findings: [
              {
                findingId,
                statement: originalText,
                ownershipReason: "Reported as a result.",
                evidenceSpans: [
                  {
                    text: originalText,
                    blockId: "results",
                    blockKind: "body_paragraph",
                    charOffsetStart: 10,
                    charOffsetEnd: 10 + originalText.length,
                    verificationStatus: "verified_exact",
                    sourceArtifact: originalSource,
                  },
                ],
              },
            ],
            credit: "single_reference",
            retained: [],
            changes: [],
            reason: "Matched the original finding.",
            provenanceArtifacts: [],
          },
          laterHops: [
            {
              useId,
              status: "assessed",
              assessments: [
                {
                  status: "assessed",
                  caseId: historyAssessmentCaseId(
                    statementId,
                    useId,
                    findingId,
                  ),
                  findingId,
                  downstreamQuote: support,
                  parentTextVersionId: middleSource.artifactId,
                  parentEvidenceStatus: "available",
                  immediateFidelity: {
                    status: "assessed",
                    verdict: "F",
                    reason: "The later paper preserves the subgroup.",
                    evidence: [
                      {
                        blockId: "results",
                        text: middleText,
                        start: 0,
                        end: middleText.length,
                      },
                    ],
                  },
                  route: {
                    kind: "independent_contribution",
                    contribution: [
                      {
                        blockId: "results",
                        text: middleText,
                        start: 0,
                        end: middleText.length,
                      },
                    ],
                  },
                  comparison: {
                    status: "scope_changed",
                    retained: ["effect"],
                    changes: ["Changed the population."],
                    reason: "The citing paper describes a subgroup.",
                  },
                  reason:
                    "The subgroup result is the intermediate authors’ finding.",
                },
              ],
              reason: "Assessed.",
              directCitation: {
                status: "unknown",
                referenceIds: [],
                provenanceArtifacts: [],
              },
              provenanceArtifacts: [],
            },
          ],
        };
      }),
    };

    const artifact = createCitationHistoryArtifact(payload);
    writeCitationHistory(root, artifact);
    const oldArtifact = join(
      citationHistoryRoot(root, report),
      buildStableId("artifact", "old history"),
    );
    mkdirSync(oldArtifact);
    writeFileSync(
      join(oldArtifact, "history.json"),
      '{"schemaVersion":"citation-history-v1"}',
    );
    expect(listCitationHistory(root, report)).toEqual([artifact]);
    expect(loadCitationHistory(root, report, artifact.artifactId)).toEqual(
      artifact,
    );
    expect(artifact.payload.citationUses).toHaveLength(1);

    const tampered = structuredClone(payload);
    const assessment = tampered.paths[0]?.laterHops[0]?.assessments[0];
    if (
      assessment?.status !== "assessed" ||
      assessment.route.kind !== "independent_contribution"
    ) {
      throw new Error("Missing test assessment");
    }
    assessment.route.contribution[0]!.start += 1;
    assessment.route.contribution[0]!.end += 1;
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(tampered)),
    ).toThrow("Intermediate route quote does not match its immutable source");

    const wrongParagraph = structuredClone(payload);
    const wrongRoute = wrongParagraph.paths[0]?.laterHops[0]?.assessments[0];
    if (
      wrongRoute?.status !== "assessed" ||
      wrongRoute.route.kind !== "independent_contribution"
    ) {
      throw new Error("Missing test assessment");
    }
    wrongRoute.route = {
      kind: "direct_restatement",
      connection: wrongRoute.route.contribution,
    };
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(wrongParagraph)),
    ).toThrow(
      "Direct restatement evidence does not match the credited first-hop paragraph",
    );

    const wrongParse = structuredClone(payload);
    wrongParse.citationUses[0]!.observationProvenance.parser = "grobid-tei";
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(wrongParse)),
    ).toThrow("Downstream citation does not match its parse provenance");

    const wrongTarget = structuredClone(payload);
    wrongTarget.citationUses[0]!.targetRefIds = ["elsewhere"];
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(wrongTarget)),
    ).toThrow(
      "Downstream citation does not match its exact occurrence in the saved source",
    );

    const wrongMatch = structuredClone(payload);
    wrongMatch.citationUses[0]!.bibliographyMatch = {
      method: "doi",
      refId: "unmarked",
    };
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(wrongMatch)),
    ).toThrow(
      "Downstream citation does not match its exact occurrence in the saved source",
    );

    const wrongSource = structuredClone(payload);
    const body = store.load(citingParse).body as Record<string, unknown>;
    const wrongSourceParse = store.persist({
      role: citingParse.role,
      body: { ...body, sourceText: sourceText.replace("[7]", "[8]") },
    });
    wrongSource.citationUses[0]!.observationProvenance.artifacts = [
      wrongSourceParse,
    ];
    expect(() =>
      writeCitationHistory(root, createCitationHistoryArtifact(wrongSource)),
    ).toThrow("Downstream source bytes do not match their parse provenance");

    const duplicatedUse = {
      ...payload,
      citationUses: [...payload.citationUses, ...payload.citationUses],
    };
    expect(() => createCitationHistoryArtifact(duplicatedUse)).toThrow(
      "duplicate downstream citation uses",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
