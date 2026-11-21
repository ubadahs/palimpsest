import { afterEach, describe, expect, it, vi } from "vitest";

import { PROMPT_VERSIONS } from "../../src/config/prompt-versions.js";
import { analysisRunConfigSchema } from "../../src/contract/run-types.js";
import { buildHistoryAssessmentAdapter } from "../../src/history/adapters.js";
import {
  historyAssessmentSchema,
  historyModelOutputSchema,
  verifyHistoryAssessments,
  type HistoryAssessmentInput,
} from "../../src/history/assessment.js";
import {
  LLMProviderError,
  toProviderJsonSchema,
  type GenerateObjectParams,
} from "../../src/integrations/llm-client.js";
import {
  appConfig,
  llmClientReturning,
  makeStore,
  removeStores,
} from "../stages/adapters.fixture.js";

afterEach(removeStores);

const sourceArtifact = {
  artifactId: "artifact_" + "a".repeat(64),
  contentHash: "b".repeat(64),
  role: "paper-text",
};
const parentStatementText = "Moss grew faster in shade [1].";
const parentRetained = ["Moss grew faster in shade"];
const connection = "We extended that shade experiment to compare two soils.";
const contribution = "Only the coarser soil reproduced faster growth in shade.";
const downstreamText = "The shade-growth effect depends on soil [2, 3].";
const input: HistoryAssessmentInput = {
  caseId: "case-1",
  original: { paperId: "original", title: "A shade experiment" },
  finding: {
    findingId: "finding-1",
    statement: "Moss grew faster in shade.",
    ownershipReason: "The authors reported measurements from their experiment.",
    evidenceSpans: [
      {
        text: "Our moss specimens grew faster in shade.",
        blockId: "s-result",
        blockKind: "body_paragraph",
        charOffsetStart: 0,
        charOffsetEnd: 40,
        sourceArtifact,
        verificationStatus: "verified_exact",
      },
    ],
  },
  parentTextVersionId: sourceArtifact.artifactId,
  parentSourceArtifact: sourceArtifact,
  parentStatementText,
  parentRetained,
  parentChanges: [],
  parentCitation: {
    context: parentStatementText,
    marker: "[1]",
    blockId: "a-background",
    originalReferenceId: "a-ref1",
    targetRefIds: ["a-ref1"],
  },
  parentBlocks: [
    { blockId: "a-background", text: `${parentStatementText} ${connection}` },
    { blockId: "a-result", text: contribution },
  ],
  downstreamText,
  downstreamExtractedClaim: "The shade-growth effect depends on soil.",
  downstreamContext: downstreamText,
  downstreamMarker: "[2, 3]",
  directCitation: "same_group",
};
const modelRow = {
  caseNumber: 1,
  downstreamQuote: downstreamText,
  immediateFidelity: {
    status: "assessed",
    verdict: "F",
    reason: "B preserves A's soil-dependent result.",
    evidence: [{ blockId: "a-result", text: contribution }],
  },
  route: {
    kind: "uptake",
    connection: [{ blockId: "a-background", text: connection }],
    contribution: [{ blockId: "a-result", text: contribution }],
  },
  comparison: {
    status: "scope_changed",
    retained: ["shade-growth effect"],
    changes: ["B conditions the effect on soil."],
    reason: "S did not compare soils.",
  },
  reason:
    "B credits the soil comparison that A conducted as an extension of S.",
};

describe("citation history assessment verification", () => {
  it("keeps an evidenced route when the immediate-source verdict quotes the wrong paper", () => {
    const [result] = verifyHistoryAssessments([input], {
      assessments: [
        {
          ...modelRow,
          immediateFidelity: {
            ...modelRow.immediateFidelity,
            verdict: "D",
            evidence: [{ blockId: "a-result", text: downstreamText }],
          },
        },
      ],
    });
    expect(result).toMatchObject({
      status: "assessed",
      route: { kind: "uptake" },
      immediateFidelity: { status: "unassessed" },
      comparison: { status: "scope_changed" },
    });
  });

  it("records transformed uptake and separately compares the wording to the particular original finding", () => {
    const verified = verifyHistoryAssessments([input], {
      assessments: [modelRow],
    });
    expect(verified).toMatchObject([
      {
        status: "assessed",
        parentTextVersionId: sourceArtifact.artifactId,
        parentEvidenceStatus: "available",
        immediateFidelity: {
          status: "assessed",
          verdict: "F",
          evidence: [
            {
              blockId: "a-result",
              text: contribution,
              start: 0,
              end: contribution.length,
            },
          ],
        },
        route: {
          kind: "uptake",
          connection: [
            {
              blockId: "a-background",
              text: connection,
              start: parentStatementText.length + 1,
            },
          ],
          contribution: [
            {
              blockId: "a-result",
              text: contribution,
              start: 0,
              end: contribution.length,
            },
          ],
        },
        comparison: { status: "scope_changed" },
      },
    ]);
    expect(historyAssessmentSchema.safeParse(verified[0]).success).toBe(true);
  });

  it("verifies both links of uptake against the exact intermediate text", () => {
    for (const route of [
      { ...modelRow.route, connection: [] },
      {
        ...modelRow.route,
        contribution: [{ blockId: "a-background", text: contribution }],
      },
      {
        ...modelRow.route,
        connection: [
          {
            blockId: "a-background",
            text: "We extended the shade experiment.",
          },
        ],
      },
    ]) {
      expect(
        verifyHistoryAssessments([input], {
          assessments: [{ ...modelRow, route }],
        }),
      ).toMatchObject([
        {
          status: "assessed",
          route: { kind: "unresolved" },
          reason:
            "Route evidence rejected by verification. The answer lacks an explanation or exact evidence from the intermediate paper.",
          comparison: { status: "scope_changed" },
        },
      ]);
    }
  });

  it("requires a direct restatement to carry a source-credited phrase", () => {
    const direct = {
      ...modelRow,
      route: {
        kind: "direct_restatement",
        connection: [{ blockId: "a-background", text: parentRetained[0] }],
      },
    };
    expect(
      verifyHistoryAssessments([input], { assessments: [direct] }),
    ).toMatchObject([
      { status: "assessed", route: { kind: "direct_restatement" } },
    ]);
    const unrelatedFragment = {
      ...direct,
      route: {
        ...direct.route,
        connection: [{ blockId: "a-background", text: "[1]." }],
      },
    };
    expect(
      verifyHistoryAssessments([input], { assessments: [unrelatedFragment] }),
    ).toMatchObject([
      {
        status: "assessed",
        route: { kind: "unresolved" },
        reason:
          "Route evidence rejected by verification. The answer lacks an explanation or exact evidence from the intermediate paper.",
      },
    ]);
  });

  it("rejects a direct restatement whose evidence also quotes an uncredited contribution in the same paragraph", () => {
    const direct = {
      ...modelRow,
      route: {
        kind: "direct_restatement",
        connection: [
          { blockId: "a-background", text: parentStatementText },
          { blockId: "a-background", text: connection },
        ],
      },
    };
    expect(
      verifyHistoryAssessments([input], { assessments: [direct] }),
    ).toMatchObject([
      {
        status: "assessed",
        route: { kind: "unresolved" },
        immediateFidelity: { status: "assessed", verdict: "F" },
      },
    ]);
    const punctuation = {
      ...input,
      parentStatementText: parentStatementText.slice(0, -1),
    };
    expect(
      verifyHistoryAssessments([punctuation], {
        assessments: [
          {
            ...direct,
            route: {
              ...direct.route,
              connection: [direct.route.connection[0]],
            },
          },
        ],
      }),
    ).toMatchObject([{ route: { kind: "direct_restatement" } }]);
  });

  it("preserves the direct comparison when the first-hop block cannot be uniquely located", () => {
    const unlocated = { ...input, parentCitation: undefined };
    const direct = {
      ...modelRow,
      route: {
        kind: "direct_restatement",
        connection: [{ blockId: "a-background", text: parentRetained[0] }],
      },
    };
    expect(
      verifyHistoryAssessments([unlocated], { assessments: [direct] }),
    ).toMatchObject([
      {
        status: "assessed",
        route: { kind: "unresolved" },
        comparison: { status: "scope_changed" },
      },
    ]);
  });

  it("preserves the direct comparison in the absence of a verified intermediate source", () => {
    const changedVersion = {
      ...input,
      parentTextVersionId: "different-version",
    };
    expect(
      verifyHistoryAssessments([changedVersion], { assessments: [modelRow] }),
    ).toMatchObject([
      {
        status: "assessed",
        parentEvidenceStatus: "unavailable",
        route: { kind: "unresolved" },
        reason:
          "Route evidence rejected by verification. The exact intermediate text was unavailable for route verification.",
        comparison: { status: "scope_changed" },
      },
    ]);
    expect(
      verifyHistoryAssessments([changedVersion], {
        assessments: [{ ...modelRow, route: { kind: "unresolved" } }],
      }),
    ).toMatchObject([
      {
        status: "assessed",
        parentEvidenceStatus: "unavailable",
        comparison: { status: "scope_changed" },
        route: { kind: "unresolved" },
      },
    ]);
  });

  it("preserves a verified route when the direct comparison lacks exact wording or documented differences", () => {
    for (const comparison of [
      { ...modelRow.comparison, retained: ["a fabricated fragment"] },
      { ...modelRow.comparison, changes: [] },
    ]) {
      expect(
        verifyHistoryAssessments([input], {
          assessments: [{ ...modelRow, comparison }],
        }),
      ).toMatchObject([
        {
          status: "assessed",
          route: { kind: "uptake", contribution: [{ text: contribution }] },
          comparison: {
            status: "uncertain",
            retained: [],
            changes: [],
            reason:
              "Comparison evidence rejected by verification. The answer lacks required exact wording, documented differences, or an explanation.",
          },
        },
      ]);
    }
  });

  it("fails closed per case on missing, duplicate, unbound, or inexact rows", () => {
    const cases = [
      input,
      { ...input, caseId: "duplicate" },
      { ...input, caseId: "missing" },
      { ...input, caseId: "unknown-handle" },
      { ...input, caseId: "fabricated" },
      { ...input, caseId: "no-connection" },
    ];
    const duplicate = { ...modelRow, caseNumber: 2 };
    const output = historyModelOutputSchema.parse({
      assessments: [
        modelRow,
        duplicate,
        duplicate,
        { ...modelRow, caseNumber: 7 },
        { ...modelRow, caseNumber: 5, downstreamQuote: "inexact quote" },
        {
          ...modelRow,
          caseNumber: 6,
          route: { ...modelRow.route, connection: [] },
        },
      ],
    });
    const verified = verifyHistoryAssessments(cases, output);
    expect(verified.map(({ status }) => status)).toEqual([
      "assessed",
      "invalid_output",
      "invalid_output",
      "invalid_output",
      "invalid_output",
      "assessed",
    ]);
  });
});

describe("production citation history assessment adapter", () => {
  it("sends strict provider-compatible evidence alternatives for the routes", () => {
    const schema = toProviderJsonSchema(historyModelOutputSchema);
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        assessments: {
          items: {
            additionalProperties: false,
            properties: {
              route: {
                anyOf: [
                  {
                    additionalProperties: false,
                    required: ["kind", "connection"],
                  },
                  {
                    additionalProperties: false,
                    required: ["kind", "connection", "contribution"],
                  },
                  {
                    additionalProperties: false,
                    required: ["kind", "contribution"],
                  },
                  { additionalProperties: false, required: ["kind"] },
                  { additionalProperties: false, required: ["kind"] },
                ],
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /"oneOf"|"minItems"|"maxItems"|"minLength"/,
    );
  });

  it("preserves request metadata and raw malformed-provider output in failure provenance", async () => {
    const llmClient = llmClientReturning(null);
    vi.spyOn(llmClient, "generateObject").mockRejectedValueOnce(
      new LLMProviderError(
        "Malformed history response",
        "malformed_output",
        false,
        {
          responseText: '{"assessments":[',
        },
      ),
    );
    const provenanceStore = makeStore();
    const assess = buildHistoryAssessmentAdapter({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient,
      provenanceStore,
    });
    const result = await assess([input]);
    expect(result).toMatchObject({
      status: "failed",
      reasonCode: "invalid_response",
    });
    expect(
      provenanceStore.load(result.execution.requestArtifact).body,
    ).toMatchObject({
      cases: [
        {
          caseNumber: 1,
          caseId: input.caseId,
          findingId: input.finding.findingId,
        },
      ],
      llm: {
        purpose: "chain-claim-matching",
        promptVersion: PROMPT_VERSIONS.historyAssessment,
      },
    });
    expect(
      provenanceStore.load(result.execution.responseArtifact),
    ).toMatchObject({
      role: "citation-history-assessment-failure",
      body: {
        error: "Malformed history response",
        modelText: '{"assessments":[',
      },
    });
  });

  it("shares the version-bound intermediate source and uses a bounded comparison when the source is oversized", async () => {
    const llmClient = llmClientReturning({ assessments: [modelRow] });
    const generateObject = vi.spyOn(llmClient, "generateObject");
    const assess = buildHistoryAssessmentAdapter({
      config: appConfig(),
      runConfig: analysisRunConfigSchema.parse({}),
      llmClient,
      provenanceStore: makeStore(),
    });

    const result = await assess([input, { ...input, caseId: "case-2" }]);
    expect(result).toMatchObject({
      status: "completed",
      execution: {
        promptVersion: PROMPT_VERSIONS.historyAssessment,
        requestArtifact: { role: "citation-history-assessment-request" },
        responseArtifact: { role: "citation-history-assessment-response" },
      },
    });
    const normal = generateObject.mock.calls[0]![0] as GenerateObjectParams;
    expect(normal).toMatchObject({
      purpose: "chain-claim-matching",
      exactCache: { keyVersion: PROMPT_VERSIONS.historyAssessment },
    });
    expect(normal.promptPrefix).toContain(sourceArtifact.artifactId);
    expect(normal.promptPrefix).toContain(contribution);
    expect(normal.promptSuffix).toContain(
      "Our moss specimens grew faster in shade.",
    );
    expect(normal.promptSuffix).toContain('"caseNumber":2');
    expect(normal.promptSuffix).toContain(
      '"verifiedFirstHopAttribution":{"blockId":"a-background","marker":"[1]","citedPaper":{"paperId":"original","title":"A shade experiment"},"bibliographyReferenceId":"a-ref1"',
    );
    expect(normal.promptSuffix).not.toContain("case-2");
    expect(normal.promptSuffix).not.toContain("Route reconsideration");

    const oversized = {
      ...input,
      parentBlocks: [{ blockId: "too-large", text: "a".repeat(400_001) }],
    };
    await assess([oversized]);
    const compact = generateObject.mock.calls[1]![0] as GenerateObjectParams;
    expect(compact.promptPrefix).toContain('"evidenceStatus":"oversized"');
    expect(compact.promptPrefix).not.toContain("too-large");
    expect(compact.promptSuffix).toContain(input.downstreamText);
    expect(
      verifyHistoryAssessments([oversized], {
        assessments: [{ ...modelRow, route: { kind: "unresolved" } }],
      }),
    ).toMatchObject([
      {
        status: "assessed",
        parentEvidenceStatus: "oversized",
        route: { kind: "unresolved" },
        comparison: { status: "scope_changed" },
      },
    ]);

    await assess([{ ...input, reconsiderRouteForQuote: downstreamText }]);
    const retry = generateObject.mock.calls[2]![0] as GenerateObjectParams;
    expect(retry.promptPrefix).toBe(normal.promptPrefix);
    expect(retry.promptSuffix).toContain("## Route reconsideration");
    expect(retry.promptSuffix).toContain(
      `"reconsiderRouteForQuote":${JSON.stringify(downstreamText)}`,
    );
  });
});
